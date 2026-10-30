<#
  HiBy Hub - send new Soulseek downloads to the cloud inbox.

  Copies finished downloads from "Soulseek Downloads\complete" to
  r2:<bucket>/soulseek. The Hub server pulls anything new from there into its
  Inbox every few minutes (deploy/soulseek-pull.sh). Files are copied, never
  moved, so Soulseek keeps sharing them.

  One-time setup (PowerShell, in the folder holding this file):
      powershell -ExecutionPolicy Bypass -File .\soulseek-push.ps1 -Install
  That checks rclone, runs a first copy, and adds a scheduled task that repeats
  it every 5 minutes while you're logged in.

  Other options:
      -Source "D:\Somewhere\complete"   a different downloads folder
      -Remote "myr2:hiby-library/soulseek"   a different rclone destination
      -MaxAge 30d     only send files downloaded in the last 30 days (default)
      -Uninstall      remove the scheduled task
  Log: %LOCALAPPDATA%\HiByHub\soulseek-push.log
#>
param(
  [string]$Source = "",
  [string]$Remote = "",
  [string]$MaxAge = "30d",
  [switch]$Install,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$TaskName = "HiBy Hub - Soulseek to Inbox"
$Home2 = Join-Path $env:LOCALAPPDATA "HiByHub"
$Log = Join-Path $Home2 "soulseek-push.log"
$Settings = Join-Path $Home2 "soulseek-push.json"
New-Item -ItemType Directory -Force -Path $Home2 | Out-Null

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Write-Host "Removed the scheduled task '$TaskName'."
  exit 0
}

# Saved settings from -Install (the scheduled task runs with no arguments).
$saved = $null
if (Test-Path $Settings) { $saved = Get-Content $Settings -Raw | ConvertFrom-Json }
if (-not $PSBoundParameters.ContainsKey('MaxAge') -and $saved -and $saved.MaxAge) { $MaxAge = $saved.MaxAge }

function Find-Rclone {
  if ($saved -and $saved.Rclone -and (Test-Path $saved.Rclone)) { return $saved.Rclone }
  $c = Get-Command rclone -ErrorAction SilentlyContinue
  if ($c) { return $c.Source }
  foreach ($p in @("$env:USERPROFILE\rclone\rclone.exe", "C:\rclone\rclone.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\rclone.exe")) {
    if (Test-Path $p) { return $p }
  }
  $hit = Get-ChildItem -Path "$env:USERPROFILE\Downloads", "C:\Program Files" -Filter rclone.exe -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($hit) { return $hit.FullName }
  throw "Can't find rclone.exe. Pass its folder in PATH, or put it in C:\rclone."
}
$Rclone = Find-Rclone

if (-not $Source) {
  if ($saved -and $saved.Source) { $Source = $saved.Source }
  else {
    $cands = @(
      "$env:USERPROFILE\Documents\Soulseek Downloads\complete",
      "$env:USERPROFILE\OneDrive\Documents\Soulseek Downloads\complete",
      "D:\Soulseek Downloads\complete"
    )
    $Source = $cands | Where-Object { Test-Path $_ } | Select-Object -First 1
    if (-not $Source) { throw "Can't find 'Soulseek Downloads\complete'. Run again with -Source ""<path to the complete folder>""." }
  }
}
if (-not (Test-Path $Source)) { throw "Downloads folder not found: $Source" }

if (-not $Remote) {
  if ($saved -and $saved.Remote) { $Remote = $saved.Remote }
  else {
    # The R2 remote set up for the big library upload (the first S3-type remote).
    $line = & $Rclone listremotes --long | Where-Object { $_ -match '\ss3\s*$' } | Select-Object -First 1
    if (-not $line) { throw "No S3/R2 remote in rclone. Run 'rclone listremotes' and pass -Remote ""<name>:hiby-library/soulseek""." }
    $Remote = ($line -split ':')[0] + ":hiby-library/soulseek"
  }
}

function Push-Once {
  $stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $Log -Value "[$stamp] $Source -> $Remote"
  & $Rclone copy "$Source" "$Remote" `
      --max-age $MaxAge --min-age 1m `
      --exclude "*.incomplete" --exclude "*.part" --exclude "*.partial" --exclude "*.tmp" `
      --exclude "desktop.ini" --exclude "Thumbs.db" `
      --transfers 4 --log-file "$Log" --log-level NOTICE --stats-one-line --stats 0
  if ($LASTEXITCODE -ne 0) { Add-Content -Path $Log -Value "[$stamp] rclone exit code $LASTEXITCODE" }
  # Keep the log small.
  if ((Get-Item $Log).Length -gt 1MB) { Get-Content $Log -Tail 500 | Set-Content $Log }
}

if ($Install) {
  Write-Host "rclone:      $Rclone"
  Write-Host "Downloads:   $Source"
  Write-Host "Sending to:  $Remote  (files from the last $MaxAge)"
  @{ Rclone = $Rclone; Source = $Source; Remote = $Remote; MaxAge = $MaxAge } | ConvertTo-Json | Set-Content $Settings

  $script = Join-Path $Home2 "soulseek-push.ps1"
  if ($PSCommandPath -ne $script) { Copy-Item -Force $PSCommandPath $script }
  # Run hidden: a tiny VBS launcher avoids a console window flashing every 5 minutes.
  $vbs = Join-Path $Home2 "soulseek-push.vbs"
  Set-Content -Path $vbs -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""' + $script + '""", 0, True')

  $action  = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
  $logon   = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $set     = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 4) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($trigger, $logon) -Settings $set -Force | Out-Null
  Write-Host "Scheduled task '$TaskName' added (every 5 minutes)."
  Write-Host "Running a first copy now..."
  Push-Once
  Write-Host "Done. New downloads appear in the Hub Inbox within about 10 minutes. Log: $Log"
  exit 0
}

Push-Once
