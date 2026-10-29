# delete-device-playlists.ps1
# Delete .m3u/.m3u8 files from the HiBy's Playlists folders. The frontend
# passes the list of relative paths (e.g. "Playlists\foo.m3u8" or
# "Music\Playlists\bar.m3u") via a JSON file to avoid command-line escaping
# headaches with weird filenames.
#
# Paths are validated server-side AND in-script: only paths that resolve to
# either of the two playlist folders are accepted. Anything else is rejected
# silently as a defensive measure.

param(
  [Parameter(Mandatory=$true)] [string]$PathsFile,
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

if (-not (Test-Path $PathsFile)) {
  Write-Result @{ ok = $false; error = "Paths input file not found: $PathsFile"; deleted = @(); errors = @() }
  exit 1
}
$pathsRaw = Get-Content -LiteralPath $PathsFile -Raw -Encoding UTF8
$paths    = @(($pathsRaw | ConvertFrom-Json))
if ($paths.Count -eq 0) {
  Write-Result @{ ok = $true; deleted = @(); errors = @(); message = "Nothing to delete." }
  exit 0
}

$shell  = New-Object -ComObject Shell.Application
$thisPC = $shell.NameSpace(17)

$device = $null
foreach ($item in $thisPC.Items()) {
  if ($item.Name -match [regex]::Escape($DeviceName) -or $item.Name -match 'HiBy') {
    $device = $item; break
  }
}
if ($null -eq $device) {
  Write-Result @{ ok = $false; error = "HiBy device not found."; deleted = @(); errors = @() }
  exit 0
}

$deviceFolder = $device.GetFolder
$volumes = @($deviceFolder.Items())
if ($volumes.Count -eq 0) {
  Start-Sleep -Seconds 2
  $volumes = @($deviceFolder.Items())
}
if ($volumes.Count -eq 0) {
  Write-Result @{ ok = $false; error = "No volumes visible - tap the HiBy screen to wake it."; deleted = @(); errors = @() }
  exit 0
}

# Index volumes by name for direct lookup from path segments.
$volumesByName = @{}
foreach ($v in $volumes) { $volumesByName[$v.Name] = $v }

$deleted = [System.Collections.Generic.List[string]]::new()
$errors  = [System.Collections.Generic.List[string]]::new()

# Try several verb spellings — Windows MTP namespaces sometimes localise or
# use the accelerator form ("D&elete"). We invoke the first one that matches.
function Invoke-Delete($item) {
  if ($null -eq $item) { return $false }
  $verbs = @()
  try { $verbs = @($item.Verbs()) } catch {}
  foreach ($v in $verbs) {
    $nm = ($v.Name -replace '&','').ToLower()
    if ($nm -eq 'delete' -or $nm -eq 'remove' -or $nm -eq 'erase') {
      try { $v.DoIt(); return $true } catch {}
    }
  }
  foreach ($verbName in @('delete', 'D&elete', 'Delete')) {
    try { $item.InvokeVerb($verbName); return $true } catch {}
  }
  return $false
}

# Resolve a path like "VolumeName\subfolder\...\file.m3u8" into the final
# Shell item, walking each segment via ParseName. Returns $null if any
# segment can't be resolved.
function Resolve-DevicePath($segments) {
  if ($segments.Count -lt 3) { return $null }
  $volName = $segments[0]
  $vol = $volumesByName[$volName]
  if ($null -eq $vol) { return $null }
  $current = $vol.GetFolder
  # Walk the folder segments (all but the last) via Items() match + GetFolder.
  # ParseName is unreliable on MTP (returns null for real folders), so we
  # iterate Items() and match by name — the same approach the scan uses.
  for ($i = 1; $i -lt $segments.Count - 1; $i++) {
    if ($null -eq $current) { return $null }
    $next = $null
    foreach ($it in $current.Items()) {
      if ($it.Name -eq $segments[$i]) {
        $f = $null
        try { $f = $it.GetFolder } catch {}
        if ($null -ne $f) { $next = $f; break }
      }
    }
    if ($null -eq $next) { return $null }
    $current = $next
  }
  if ($null -eq $current) { return $null }
  # Match the file by its display name. MTP strips the .m3u8 extension, so the
  # incoming segment is e.g. "Dance" or "Dance.20260519-224248" — we match
  # whatever the folder enumeration reports.
  $targetName = $segments[-1]
  foreach ($it in $current.Items()) {
    if ($it.Name -eq $targetName) { return $it }
  }
  return $null
}

foreach ($relPath in $paths) {
  $rel = [string]$relPath
  $segments = $rel -split '\\'

  # Validate shape: must be <Volume>\Playlists\<file> OR <Volume>\Music\Playlists\<file>
  # OR <Volume>\HiByMusic\Playlists\<file>
  $valid = $false
  if ($segments.Count -eq 3 -and $segments[1] -eq 'Playlists') { $valid = $true }
  elseif ($segments.Count -eq 4 -and $segments[1] -eq 'Music'     -and $segments[2] -eq 'Playlists') { $valid = $true }
  elseif ($segments.Count -eq 4 -and $segments[1] -eq 'HiByMusic' -and $segments[2] -eq 'Playlists') { $valid = $true }

  if (-not $valid) {
    $errors.Add("$rel - rejected: not inside a recognised Playlists folder")
    continue
  }
  # NOTE: no extension requirement — MTP strips .m3u8 from displayed names,
  # so the segment is often just "Dance". The Playlists-folder location check
  # above is the safety guard.
  #
  # Run the resolve+delete inside a background job with a hard 12s timeout.
  # On some HiBy firmware the MTP delete verb blocks forever on a hidden
  # confirmation dialog the script can't answer; without a bounded job that
  # hangs the whole request. If it times out we kill the job (and any dialog
  # it owns) and report that the device blocked the delete.
  $delJob = Start-Job -ScriptBlock {
    param($deviceMatch, $segs)
    try {
      $sh = New-Object -ComObject Shell.Application
      $thisPC = $sh.NameSpace(17)
      $dev = $null
      foreach ($it in $thisPC.Items()) { if ($it.Name -match $deviceMatch) { $dev = $it; break } }
      if ($null -eq $dev) { return 'no-device' }
      $vol = $null
      foreach ($v in $dev.GetFolder.Items()) { if ($v.Name -eq $segs[0]) { $vol = $v; break } }
      if ($null -eq $vol) { return 'no-vol' }
      $cur = $vol.GetFolder
      for ($i = 1; $i -lt $segs.Count - 1; $i++) {
        $nx = $null
        foreach ($it in $cur.Items()) { if ($it.Name -eq $segs[$i]) { try { $nx = $it.GetFolder } catch {}; if ($nx) { break } } }
        if ($null -eq $nx) { return 'no-folder' }
        $cur = $nx
      }
      $file = $null
      foreach ($it in $cur.Items()) { if ($it.Name -eq $segs[-1]) { $file = $it; break } }
      if ($null -eq $file) { return 'not-found' }
      foreach ($vb in @($file.Verbs())) {
        if (($vb.Name -replace '&','').ToLower() -eq 'delete') { $vb.DoIt(); return 'deleted' }
      }
      try { $file.InvokeVerb('delete'); return 'deleted-invoke' } catch {}
      return 'no-verb'
    } catch { return "err: $($_.Exception.Message)" }
  } -ArgumentList $DeviceMatch, $segments

  $done = Wait-Job -Job $delJob -Timeout 12
  if ($done) {
    $r = Receive-Job -Job $delJob
    Remove-Job -Job $delJob -Force -ErrorAction SilentlyContinue
    if ($r -like 'deleted*') { $deleted.Add($rel) }
    else { $errors.Add("$rel - $r") }
  } else {
    Stop-Job -Job $delJob -ErrorAction SilentlyContinue
    Remove-Job -Job $delJob -Force -ErrorAction SilentlyContinue
    $errors.Add("$rel - device blocked the delete (timed out; this firmware requires manual deletion via Windows Explorer)")
  }
}

# MTP deletes are async — let them flush before exiting.
Start-Sleep -Seconds 2

Write-Result @{
  ok      = $deleted.Count -gt 0 -or ($errors.Count -eq 0)
  deleted = $deleted.ToArray()
  errors  = $errors.ToArray()
  total   = $paths.Count
}

} catch {
  $msg = $_.Exception.Message
  $line = $_.InvocationInfo.ScriptLineNumber
  Write-Result @{ ok = $false; error = "Unhandled exception at line ${line}: $msg"; deleted = @(); errors = @() }
  exit 1
}
