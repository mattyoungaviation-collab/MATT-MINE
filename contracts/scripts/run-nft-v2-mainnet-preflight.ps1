$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

function Invoke-Checked([string] $Label, [scriptblock] $Action) {
    Write-Host "`n[$Label]" -ForegroundColor Cyan
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE." }
}

try {
    Invoke-Checked "JavaScript and configuration checks" { npm.cmd run check }
    Invoke-Checked "NFT V2 source security audit" { npm.cmd run contracts:audit-nft-v2 }
    Invoke-Checked "Production Solidity compile" { npm.cmd run contracts:compile }
    Invoke-Checked "Game and server tests" { npm.cmd run test:game }
    Invoke-Checked "Solidity contract tests" { npm.cmd run test:contracts }
    Invoke-Checked "Read-only Ronin configuration validation" { npm.cmd run contracts:validate-nft-v2:ronin }
    Invoke-Checked "Encrypted 0xF799 deployer and gas preflight" { npm.cmd run contracts:check-nft-v2-deployer:ronin }
    Write-Host "`nMATT Mine NFT V2 is ready for a paused Ronin Mainnet deployment. No transaction was broadcast." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nPreflight stopped safely: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}

Read-Host "Press Enter to close this secure preflight window"
exit $exitCode
