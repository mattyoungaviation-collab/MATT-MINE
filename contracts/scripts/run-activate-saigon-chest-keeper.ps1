$ErrorActionPreference = "Continue"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$env:MATT_MINE_NFT_SAIGON_KEEPER_CONFIRMATION = "ACTIVATE_DEDICATED_MATT_MINE_SAIGON_CHEST_KEEPER"
try {
    npm.cmd --workspace contracts run activate-chest-keeper:saigon
    $activationExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:MATT_MINE_NFT_SAIGON_KEEPER_CONFIRMATION -ErrorAction SilentlyContinue
}

if ($activationExitCode -eq 0) {
    Write-Host "`nDedicated Saigon chest keeper activated." -ForegroundColor Green
}
else {
    Write-Host "`nKeeper activation stopped safely with exit code $activationExitCode." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this secure keeper activation window"
exit $activationExitCode
