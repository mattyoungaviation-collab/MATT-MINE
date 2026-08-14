$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$launchpadMinter = Read-Host "Enter the final approved Ronin Launchpad Miner minter address"
if ($launchpadMinter -notmatch '^0x[0-9a-fA-F]{40}$') {
    Write-Host "Invalid Launchpad minter address. Nothing was broadcast." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}
$env:MATT_MINE_NFT_V2_LAUNCHPAD_MINTER_ADDRESS = $launchpadMinter
$env:MATT_MINE_NFT_V2_MAINNET_ACTIVATION = "ACTIVATE_MATT_MINE_NFT_V2_ON_RONIN_MAINNET"

try {
    npm.cmd run contracts:check-nft-v2-activation:ronin
    if ($LASTEXITCODE -ne 0) { throw "Activation readiness failed. Nothing was broadcast." }
    $confirmation = Read-Host "Type ACTIVATE to assign roles and unpause the verified V2 suite"
    if ($confirmation -cne 'ACTIVATE') { throw "Activation was cancelled. Nothing was broadcast." }
    npm.cmd run contracts:activate-nft-v2:ronin
    if ($LASTEXITCODE -ne 0) { throw "Activation failed with exit code $LASTEXITCODE." }
    Write-Host "`nNFT V2 activated with separated production roles." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nActivation stopped safely: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}
finally {
    Remove-Item Env:MATT_MINE_NFT_V2_LAUNCHPAD_MINTER_ADDRESS -ErrorAction SilentlyContinue
    Remove-Item Env:MATT_MINE_NFT_V2_MAINNET_ACTIVATION -ErrorAction SilentlyContinue
}

Read-Host "Press Enter to close this secure activation window"
exit $exitCode
