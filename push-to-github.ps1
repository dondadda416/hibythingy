Set-Location $PSScriptRoot

# Clean up any broken .git from previous attempt
if (Test-Path ".git") {
    Write-Host "Removing old .git folder..." -ForegroundColor Yellow
    Remove-Item ".git" -Recurse -Force
}

git init -b main
git config user.name "dondadda416"
git config user.email "cindy@dataonthespot.com"
git add -A
git commit -m "Initial commit: HiBy Hub v1.0"
git remote add origin https://github.com/dondadda416/hibythingy.git
git push -u origin main

Write-Host ""
Write-Host "Done! https://github.com/dondadda416/hibythingy" -ForegroundColor Green
Write-Host ""
pause
