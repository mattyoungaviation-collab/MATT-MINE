$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$confirmation = Read-Host "Type EXECUTE to install the scheduled batch-enabled Chest implementation"
if ($confirmation -cne "EXECUTE") {
    Write-Host "Nothing was broadcast." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}

$env:MATT_MINE_CHEST_BATCH_UPGRADE_CONFIRMATION = "EXECUTE_CHEST_BATCH_UPGRADE"
try {
    npm.cmd run contracts:execute-nft-v2-chest-batch-upgrade:ronin
    if ($LASTEXITCODE -ne 0) { throw "Chest batch upgrade execution failed with exit code $LASTEXITCODE." }
    Write-Host "`nChest batch purchasing is live. Players can buy up to ten same-slot chests per transaction." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nStopped safely: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}
finally {
    Remove-Item Env:MATT_MINE_CHEST_BATCH_UPGRADE_CONFIRMATION -ErrorAction SilentlyContinue
}
Read-Host "Press Enter to close this secure window"
exit $exitCode
