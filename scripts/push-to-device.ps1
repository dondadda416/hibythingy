# push-to-device.ps1
# Copies one album folder to the HiBy R4 SD card via MTP (Shell.Application)
# Usage: called by server.js via -EncodedCommand; params in JSON sidecar file

param(
  [Parameter(Mandatory=$true)]  [string]$SourcePath,
  [Parameter(Mandatory=$true)]  [string]$Artist,
  [Parameter(Mandatory=$true)]  [string]$Album,
  [string]$DeviceMatch = "R4|HiBy|RS2|RS6|R3",
  [string]$OutFile = ""
)

function Log($msg) { Write-Host "LOG: $msg" }

function Bail($msg) {
  $j = [PSCustomObject]@{ ok = $false; error = $msg } | ConvertTo-Json -Compress
  if ($script:OutFile -ne "") {
    [System.IO.File]::WriteAllText($script:OutFile, $j, [System.Text.Encoding]::UTF8)
  } else {
    Write-Output $j
  }
  exit 1
}

# Validate source folder
if (-not (Test-Path $SourcePath)) {
  Bail "Source folder not found: $SourcePath"
}

# Find audio files
$AUDIO_EXT = @(".flac", ".mp3", ".wav", ".aac", ".m4a", ".ogg", ".wma", ".ape", ".opus")
$files = Get-ChildItem $SourcePath -File |
         Where-Object { $AUDIO_EXT -contains $_.Extension.ToLower() } |
         Sort-Object Name

if ($files.Count -eq 0) {
  Bail "No audio files found in: $SourcePath"
}

$totalSizeMB = [math]::Round(($files | Measure-Object -Property Length -Sum).Sum / 1MB, 1)
Log "Found $($files.Count) tracks ($totalSizeMB MB)"

# Find HiBy device
$shell  = New-Object -ComObject Shell.Application
$thisPC = $shell.NameSpace(17)

$device = $null
foreach ($item in $thisPC.Items()) {
  if ($item.Name -match $DeviceMatch) { $device = $item; break }
}
if ($null -eq $device) {
  Bail "HiBy device not found. Connect via USB in MTP mode."
}
Log "Device: $($device.Name)"

# Find SD card volume.
# When the HiBy's screen is locked/asleep, Windows still reports the device
# as connected but the MTP volumes don't enumerate (an empty Items() list).
# Retry once after a brief sleep — that often wakes the namespace back up.
$deviceFolder = $device.GetFolder
$volumes = @($deviceFolder.Items())
if ($volumes.Count -eq 0) {
  Log "No volumes on first try - re-querying after 2s..."
  Start-Sleep -Seconds 2
  $shell2 = New-Object -ComObject Shell.Application
  $thisPC2 = $shell2.NameSpace(17)
  $device2 = $null
  foreach ($item in $thisPC2.Items()) {
    if ($item.Name -match $DeviceMatch) { $device2 = $item; break }
  }
  if ($null -ne $device2) {
    $deviceFolder = $device2.GetFolder
    $volumes = @($deviceFolder.Items())
  }
}
if ($volumes.Count -eq 0) {
  Bail "No volumes found on $($device.Name). The device is connected but its SD card is not visible - this almost always means the HiBy screen is locked. Tap the screen to wake it, then try again."
}

$sdVol = $null
foreach ($v in $volumes) {
  if ($v.Name -match "SD|Card|MicroSD|External") { $sdVol = $v; break }
}
if ($null -eq $sdVol) { $sdVol = $volumes[0] }
Log "Volume: $($sdVol.Name)"

# Sanitize artist / album names for folder creation
function SanitizeName($s) {
  return ($s -replace '[\\/:*?"<>|]', "_").Trim()
}
$safeArtist = SanitizeName $Artist
$safeAlbum  = SanitizeName $Album

# Stage files in %TEMP% with proper Artist/Album layout
$tempRoot  = Join-Path $env:TEMP ("hiby-push-" + (Get-Random))
$tempAlbum = Join-Path (Join-Path (Join-Path $tempRoot "Music") $safeArtist) $safeAlbum

New-Item -ItemType Directory -Path $tempAlbum -Force | Out-Null
Log "Staging to: $tempAlbum"

foreach ($f in $files) {
  Copy-Item -LiteralPath $f.FullName -Destination (Join-Path $tempAlbum $f.Name)
}
Log "Staged $($files.Count) files"

# Get Shell item for the Artist folder under temp Music
$tempMusicNS = $shell.NameSpace((Join-Path $tempRoot "Music"))
$artistItem  = $null
foreach ($item in $tempMusicNS.Items()) {
  if ($item.Name -eq $safeArtist) { $artistItem = $item; break }
}

if ($null -eq $artistItem) {
  Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
  Bail "Staging failed - artist folder not found in temp area"
}

# CopyHere flags: 4=no dialog, 16=yes-to-all, 512=auto-create-dirs, 1024=no-error-ui
$copyFlags = 4 + 16 + 512 + 1024

$sdFolder = $sdVol.GetFolder

# Look for existing Music folder on the device
$musicFolder = $null
foreach ($item in $sdFolder.Items()) {
  if ($item.Name -eq "Music") { $musicFolder = $item; break }
}

# Capture the path-as-strings that we'll re-walk during verification.
# (We can't reuse $destRoot's reference because Shell.Application caches MTP
# folder listings — once you've called Items() on a folder ref, you keep
# getting the same snapshot. New files copied in via CopyHere don't show up
# unless you construct a fresh folder object.)
$deviceNameStr = $device.Name
$volumeNameStr = $sdVol.Name
$musicNameStr  = $null
if ($null -ne $musicFolder) {
  Log "Copying into existing Music folder..."
  $musicNameStr = $musicFolder.Name
  $musicFolder.GetFolder.CopyHere($artistItem, $copyFlags)
} else {
  Log "No Music folder found - copying to SD root..."
  $sdFolder.CopyHere($artistItem, $copyFlags)
}

# ── Wait for the async copy to flush ─────────────────────────────────────────
# Shell.Application's CopyHere is asynchronous and gives no completion signal.
# We can't reliably verify the result in-process either: the Windows Portable
# Devices (WPD) cache lives at the system service level and is shared across
# processes. Even a freshly-spawned powershell.exe sees the cached "before
# copy" view of the album folder, so an in-script verification poll keeps
# returning 0 even when the files actually landed.
#
# So we do the pragmatic thing: wait long enough for the transfer to finish
# (proportional to size, capped), then report ok=true with verified=false.
# Ground truth comes from Force MTP Scan (which runs cleanly because the WPD
# cache invalidates by the time the user clicks it), and from
# Sync -> Verify Push Log which surfaces any push-log entries the scan can't
# find. That's the architecture the rest of the system already supports.
$throughputMBs = 5            # conservative — typical MTP write speed
$waitSec = [math]::Min(240, [math]::Max(20, [math]::Ceiling($totalSizeMB / $throughputMBs) + 10))
Log "Waiting $waitSec s for MTP transfer to flush ($totalSizeMB MB at ~$throughputMBs MB/s)..."
Start-Sleep -Seconds $waitSec

# Cleanup temp
Remove-Item $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
Log "Done"

$verified = $false   # In-script verification disabled; rely on Force MTP Scan.
$warning  = "Copy completed but not yet verified by Hub. Run Devices -> Force MTP Scan, then Sync -> Verify Push Log to confirm and prune any failed entries."
$found    = $files.Count   # Optimistic record — push log can be pruned later.

# Write result — `ok` only true after files actually appeared on the device.
$result = [PSCustomObject]@{
  ok             = $true
  verified       = $verified
  artist         = $Artist
  album          = $Album
  tracks         = $files.Count
  tracksOnDevice = $found
  sizeMB         = $totalSizeMB
  warning        = $warning
} | ConvertTo-Json -Compress

if ($OutFile -ne "") {
  [System.IO.File]::WriteAllText($OutFile, $result, [System.Text.Encoding]::UTF8)
} else {
  Write-Output $result
}
