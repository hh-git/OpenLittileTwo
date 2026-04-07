$env:Path = "C:\Program Files\nodejs;$env:Path"
Set-Location $PSScriptRoot

# Check if node_modules exists
if (-not (Test-Path "node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    & "C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm\bin\npm-cli.js" install
}

# Check if tsx is installed
if (-not (Test-Path "node_modules\tsx")) {
    Write-Host "Installing tsx..." -ForegroundColor Yellow
    & "C:\Program Files\nodejs\node.exe" "C:\Program Files\nodejs\node_modules\npm-cli.js" install tsx --save-dev
}

# Run the CLI
Write-Host "Starting openLittleTwo..." -ForegroundColor Green
& "C:\Program Files\nodejs\node.exe" "node_modules\tsx\dist\cli.mjs" "src/cli/index.ts" @args
