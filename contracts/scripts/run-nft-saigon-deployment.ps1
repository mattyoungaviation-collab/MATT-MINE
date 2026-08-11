$ErrorActionPreference = "Continue"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$env:MATT_MINE_NFT_SAIGON_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V1_TO_SAIGON"
try {
    npm.cmd run contracts:deploy-nft:saigon
    $deploymentExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:MATT_MINE_NFT_SAIGON_CONFIRMATION -ErrorAction SilentlyContinue
}

if ($deploymentExitCode -eq 0) {
    Write-Host "`nSaigon deployment completed. Codex will verify the saved manifest." -ForegroundColor Green
}
else {
    Write-Host "`nDeployment stopped safely with exit code $deploymentExitCode. Leave this window open so Codex can inspect the checkpoint." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this secure deployment window"
exit $deploymentExitCode
