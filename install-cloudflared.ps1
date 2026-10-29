# install-cloudflared.ps1
# Downloads and installs cloudflared, then walks through tunnel login.
# Run in PowerShell (as Administrator for the service install step later).

$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "=== HiBy Hub: Cloudflare Tunnel Setup ===" -ForegroundColor Cyan
Write-Host ""

# Step 1: Download
$msiUrl  = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.msi"
$msiPath = "$env:TEMP\cloudflared-windows-amd64.msi"

Write-Host "[1/4] Downloading cloudflared..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $msiUrl -OutFile $msiPath -UseBasicParsing
Write-Host "      Done: $msiPath" -ForegroundColor Green

# Step 2: Install silently
Write-Host "[2/4] Installing cloudflared..." -ForegroundColor Yellow
Start-Process msiexec.exe -ArgumentList "/i `"$msiPath`" /quiet /norestart" -Wait
Write-Host "      Installation complete." -ForegroundColor Green

# Reload PATH so cloudflared is available in this session
$env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" +
            [System.Environment]::GetEnvironmentVariable("Path","User")

# Step 3: Verify
Write-Host "[3/4] Verifying installation..." -ForegroundColor Yellow
cloudflared --version
Write-Host "" -ForegroundColor Green

# Step 4: Login (opens browser)
Write-Host "[4/4] Opening Cloudflare login in your browser..." -ForegroundColor Yellow
Write-Host "      Select the domain you want to use for HiBy Hub." -ForegroundColor White
Write-Host ""
cloudflared tunnel login

Write-Host ""
Write-Host "=== Login complete! ===" -ForegroundColor Cyan
Write-Host ""
Write-Host "Now run this command to create the tunnel:" -ForegroundColor White
Write-Host ""
Write-Host "    cloudflared tunnel create hiby-hub" -ForegroundColor Yellow
Write-Host ""
Write-Host "Paste the tunnel UUID back into Claude to finish the setup." -ForegroundColor White
Write-Host ""
