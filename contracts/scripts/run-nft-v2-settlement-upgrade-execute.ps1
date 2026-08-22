$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$confirmation = Read-Host "Type EXECUTE to install the scheduled Settlement upgrade"
if ($confirmation -cne "EXECUTE") {
    Write-Host "Nothing was broadcast." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}

$env:MATT_MINE_SETTLEMENT_UPGRADE_CONFIRMATION = "EXECUTE_SETTLEMENT_XP_UPGRADE"
try {
    npm.cmd run contracts:execute-nft-v2-settlement-upgrade:ronin
    if ($LASTEXITCODE -ne 0) { throw "Settlement upgrade execution failed with exit code $LASTEXITCODE." }
    Write-Host "`nSettlement upgraded. Phase XP controls are now available." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nStopped safely: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}
finally {
    Remove-Item Env:MATT_MINE_SETTLEMENT_UPGRADE_CONFIRMATION -ErrorAction SilentlyContinue
}
Read-Host "Press Enter to close this secure window"
exit $exitCode
