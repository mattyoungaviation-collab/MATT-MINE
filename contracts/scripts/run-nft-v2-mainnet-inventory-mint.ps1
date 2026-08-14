$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$salesWallet = Read-Host "Enter the dedicated normal Ronin wallet that will hold and list all 1,000 Miners"
if ($salesWallet -notmatch '^0x[0-9a-fA-F]{40}$') {
    Write-Host "Invalid sales wallet address. Nothing was broadcast." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}
$env:MATT_MINE_NFT_V2_SALES_WALLET_ADDRESS = $salesWallet

try {
    npm.cmd run contracts:check-nft-v2-inventory:ronin
    if ($LASTEXITCODE -ne 0) { throw "Marketplace inventory readiness failed. Nothing was broadcast." }
    $confirmation = Read-Host "Type MINT 1000 to mint the entire collection to $salesWallet"
    if ($confirmation -cne 'MINT 1000') { throw "Inventory mint was cancelled. Nothing was broadcast." }
    $env:MATT_MINE_NFT_V2_MAINNET_PREMINT = "PREMINT_MATT_MINE_MARKET_INVENTORY_ON_RONIN_MAINNET"
    npm.cmd run contracts:premint-nft-v2-inventory:ronin
    if ($LASTEXITCODE -ne 0) { throw "Inventory mint stopped with exit code $LASTEXITCODE. The script re-pauses safely and can resume." }
    Write-Host "`nAll 1,000 Miners are in the dedicated sales wallet and minting is paused." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nMarketplace inventory procedure stopped: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}
finally {
    Remove-Item Env:MATT_MINE_NFT_V2_SALES_WALLET_ADDRESS -ErrorAction SilentlyContinue
    Remove-Item Env:MATT_MINE_NFT_V2_MAINNET_PREMINT -ErrorAction SilentlyContinue
}

Read-Host "Press Enter to close this secure inventory window"
exit $exitCode
