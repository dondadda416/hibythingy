# list-device-playlists.ps1
# Walk both SD:\Playlists\ and SD:\Music\Playlists\ on the HiBy and return
# every .m3u / .m3u8 file found. Output is structured JSON so the server can
# enrich it with duplicate-detection metadata before showing the user.

param(
  [string]$DeviceName = "R4",
  [string]$OutFile = ""
)

function Write-Result($obj) {
  $json = $obj | ConvertTo-Json -Depth 4 -Compress
  if ($OutFile -ne "") {
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.Encoding]::UTF8)
  } else { Write-Output $json }
}

try {

$shell  = New-Object -ComObject Shell.Application
$thisPC = $shell.NameSpace(17)

$device = $null
foreach ($item in $thisPC.Items()) {
  if ($item.Name -match [regex]::Escape($DeviceName) -or $item.Name -match 'HiBy') {
    $device = $item; break
  }
}
if ($null -eq $device) {
  Write-Result @{ ok = $false; error = "HiBy device not found. Connect via USB in MTP mode."; files = @() }
  exit 0
}

$deviceFolder = $device.GetFolder
$volumes = @($deviceFolder.Items())
# Locked-device retry — see push scripts for context. Single retry with a
# fresh Shell.Application instance is enough in practice.
if ($volumes.Count -eq 0) {
  Start-Sleep -Seconds 2
  $shell2  = New-Object -ComObject Shell.Application
  $thisPC2 = $shell2.NameSpace(17)
  foreach ($item in $thisPC2.Items()) {
    if ($item.Name -match [regex]::Escape($DeviceName) -or $item.Name -match 'HiBy') {
      $device = $item; $deviceFolder = $item.GetFolder; break
    }
  }
  $volumes = @($deviceFolder.Items())
}
if ($volumes.Count -eq 0) {
  Write-Result @{ ok = $false; error = "No volumes visible - tap the HiBy screen to wake it and try again."; files = @() }
  exit 0
}

$files = [System.Collections.Generic.List[hashtable]]::new()
$diagnostics = [System.Collections.Generic.List[hashtable]]::new()

$script:lastRawItems = @()
function Scan-PlaylistFolder($folder, $locationLabel) {
  if ($null -eq $folder) { return 0 }
  $count = 0
  $raw = [System.Collections.Generic.List[string]]::new()
  foreach ($item in $folder.Items()) {
    $raw.Add($item.Name)
    # Skip real subfolders. IsFolder lies on MTP, so test GetFolder instead.
    $isFolder = $false
    try { if ($null -ne $item.GetFolder) { $isFolder = $true } } catch {}
    if ($isFolder) { continue }
    # Everything else inside a Playlists folder is a playlist file. MTP
    # routinely STRIPS the .m3u8 extension from the displayed name (we see
    # "Dance" instead of "Dance.m3u8"), so we cannot filter on extension —
    # we accept every file in the folder. The display name is kept as-is;
    # the delete path resolves it back via ParseName on the same name.
    $name = $item.Name
    $extMatch = ($name -match '\.(m3u8|m3u)$')
    $files.Add(@{
      name      = $name
      location  = $locationLabel
      path      = "$locationLabel\$name"
      ext       = if ($extMatch) { [System.IO.Path]::GetExtension($name).ToLower() } else { '' }
      extHidden = (-not $extMatch)
    })
    $count++
  }
  $script:lastRawItems = $raw.ToArray()
  return $count
}

# Walk EVERY volume on the device — internal storage and SD card alike.
# HiByMusic on the R4 imports playlists from whichever volume has them, so
# we have to look in all of them. Skip system / hidden folders.
$skipFolders = @('System Volume Information', '$RECYCLE.BIN', 'LOST.DIR', 'Android', '.thumbnails')

foreach ($vol in $volumes) {
  if ($null -eq $vol) { continue }
  $volFolder = $vol.GetFolder
  if ($null -eq $volFolder) { continue }

  # Diagnostic: list every top-level folder on this volume so we can show
  # the user what's actually there if no playlists are found.
  $topFolders = [System.Collections.Generic.List[string]]::new()
  foreach ($it in $volFolder.Items()) {
    if ($it.IsFolder -and -not ($skipFolders -contains $it.Name)) {
      $topFolders.Add($it.Name)
    }
  }

  $volLabel = $vol.Name
  # Use this prefix for the relative path so the delete script can resolve
  # back to the right volume + folder. Format: "<VolumeName>\<sub>\..."
  $volPrefix = $volLabel

  # Helper: resolve a child folder by name without trusting IsFolder. MTP
  # items returned by ParseName routinely report IsFolder=$false even for
  # real folders, which silently skipped the whole scan. The reliable test
  # is "does .GetFolder return a non-null Folder object?".
  function Get-Child($parentFolder, $name) {
    if ($null -eq $parentFolder) { return $null }
    # Try ParseName first (fast path).
    $item = $null
    try { $item = $parentFolder.ParseName($name) } catch {}
    if ($null -ne $item) {
      $f = $null
      try { $f = $item.GetFolder } catch {}
      if ($null -ne $f) { return $f }
    }
    # Fallback: Items() walk. On MTP, ParseName sometimes returns null for a
    # folder that Items() enumeration finds fine — so this is the reliable
    # path (it's what the album scan uses).
    foreach ($it in $parentFolder.Items()) {
      if ($it.Name -eq $name) {
        $f = $null
        try { $f = $it.GetFolder } catch {}
        if ($null -ne $f) { return $f }
      }
    }
    return $null
  }

  # <vol>\Playlists\
  $rootPLf = Get-Child $volFolder "Playlists"
  $rootCount = 0
  if ($null -ne $rootPLf) {
    $rootCount = Scan-PlaylistFolder $rootPLf "$volPrefix\Playlists"
  }

  # <vol>\Music\Playlists\
  $musicCount = 0
  $musicRaw = @()
  $musicF = Get-Child $volFolder "Music"
  $musicPLf = $null
  if ($null -ne $musicF) {
    $musicPLf = Get-Child $musicF "Playlists"
    if ($null -ne $musicPLf) {
      $musicCount = Scan-PlaylistFolder $musicPLf "$volPrefix\Music\Playlists"
      $musicRaw = $script:lastRawItems
    }
  }

  # <vol>\HiByMusic\Playlists\   (some R4 firmware uses this path)
  $hibyCount = 0
  $hibyF = Get-Child $volFolder "HiByMusic"
  $hibyPLf = $null
  if ($null -ne $hibyF) {
    $hibyPLf = Get-Child $hibyF "Playlists"
    if ($null -ne $hibyPLf) {
      $hibyCount = Scan-PlaylistFolder $hibyPLf "$volPrefix\HiByMusic\Playlists"
    }
  }

  $diagnostics.Add(@{
    volume         = $volLabel
    topFolders     = $topFolders.ToArray()
    rootPL         = ($null -ne $rootPLf)
    musicPL        = ($null -ne $musicPLf)
    hibyPL         = ($null -ne $hibyPLf)
    rootCount      = $rootCount
    musicCount     = $musicCount
    hibyCount      = $hibyCount
    musicRaw       = $musicRaw
  })
}

Write-Result @{
  ok          = $true
  deviceName  = $device.Name
  volumes     = ($volumes | ForEach-Object { $_.Name })
  files       = $files.ToArray()
  diagnostics = $diagnostics.ToArray()
}

} catch {
  $msg = $_.Exception.Message
  $line = $_.InvocationInfo.ScriptLineNumber
  Write-Result @{ ok = $false; error = "Unhandled exception at line ${line}: $msg"; files = @() }
  exit 1
}
