$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory
$env:MATT_MINE_NFT_V2_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V2_TO_RONIN_MAINNET"

try {
    npm.cmd run contracts:deploy-nft-v2:ronin
    if ($LASTEXITCODE -ne 0) { throw "Paused deployment failed with exit code $LASTEXITCODE." }
    npm.cmd run contracts:check-nft-v2:ronin
    if ($LASTEXITCODE -ne 0) { throw "Post-deployment verification failed with exit code $LASTEXITCODE." }
    Write-Host "`nNFT V2 deployed, configured, empty, verified on-chain, and PAUSED. No mint or gameplay path is live." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nDeployment stopped safely: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}
finally {
    Remove-Item Env:MATT_MINE_NFT_V2_MAINNET_CONFIRMATION -ErrorAction SilentlyContinue
}

Read-Host "Press Enter to close this secure deployment window"
exit $exitCode
