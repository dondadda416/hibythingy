# test-device-walk.ps1 — Diagnostic: walk R4 using .GetFolder (not NameSpace by path)

param([string]$DeviceName = "R4")

function Log($msg) { Write-Host "LOG: $msg" }

$shell  = New-Object -ComObject Shell.Application
$thisPC = $shell.Namespace(17)

$device = $null
foreach ($item in $thisPC.Items()) {
    if ($item.Name -match [regex]::Escape($DeviceName) -or $item.Name -match 'HiBy') {
        $device = $item
        break
    }
}

if ($null -eq $device) {
    Write-Output "ERROR: Device not found"
    exit 1
}

Log "Found device: $($device.Name)"
$deviceFolder = $device.GetFolder

if ($null -eq $deviceFolder) {
    Write-Output "ERROR: device.GetFolder returned null"
    exit 1
}

$volumes = @($deviceFolder.Items())
Log "Volume count: $($volumes.Count)"

foreach ($vol in $volumes) {
    Log "Volume: $($vol.Name) | IsFolder: $($vol.IsFolder)"
    if (-not $vol.IsFolder) { continue }

    $volFolder = $vol.GetFolder
    if ($null -eq $volFolder) {
        Log "  -> GetFolder returned null for this volume"
        continue
    }

    $topItems = @($volFolder.Items())
    Log "  -> $($topItems.Count) top-level folders/files"
    foreach ($ti in $topItems | Select-Object -First 8) {
        Log "     $($ti.Name) [folder=$($ti.IsFolder)]"
    }
    if ($topItems.Count -gt 8) { Log "     ... and $($topItems.Count - 8) more" }
}

Write-Output "DONE"
