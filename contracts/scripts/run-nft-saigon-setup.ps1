$ErrorActionPreference = "Continue"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$env:MATT_MINE_NFT_SAIGON_SETUP_CONFIRMATION = "CONFIGURE_MATT_MINE_NFT_V1_ON_SAIGON"
try {
    npm.cmd run contracts:configure-nft:saigon
    $setupExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:MATT_MINE_NFT_SAIGON_SETUP_CONFIRMATION -ErrorAction SilentlyContinue
}

if ($setupExitCode -eq 0) {
    npm.cmd run contracts:check-nft:saigon
    $setupExitCode = $LASTEXITCODE
}

if ($setupExitCode -eq 0) {
    Write-Host "`nSaigon configuration and read-only verification completed. Contracts remain paused." -ForegroundColor Green
}
else {
    Write-Host "`nSetup stopped safely with exit code $setupExitCode. The script is resumable." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this secure setup window"
exit $setupExitCode
