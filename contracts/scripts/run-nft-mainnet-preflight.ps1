$ErrorActionPreference = "Continue"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

if (-not $env:MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS) {
    $env:MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS = "0xeED0491B506C78EA7fD10988B1E98A3C88e1C630"
}

try {
    npm.cmd run contracts:check-nft-deployer:ronin
    $preflightExitCode = $LASTEXITCODE
}
finally {
    Remove-Item Env:MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS -ErrorAction SilentlyContinue
}

if ($preflightExitCode -eq 0) {
    Write-Host "`nMainnet NFT deployer preflight passed. No transaction was broadcast." -ForegroundColor Green
}
else {
    Write-Host "`nPreflight stopped safely with exit code $preflightExitCode." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this secure preflight window"
exit $preflightExitCode
