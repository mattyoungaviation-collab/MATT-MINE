$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$confirmation = Read-Host "Type SCHEDULE to deploy the batch-enabled Chest implementation and start the 48-hour countdown"
if ($confirmation -cne "SCHEDULE") {
    Write-Host "Nothing was broadcast." -ForegroundColor Yellow
    Read-Host "Press Enter to close"
    exit 1
}

$env:MATT_MINE_CHEST_BATCH_UPGRADE_CONFIRMATION = "SCHEDULE_CHEST_BATCH_UPGRADE"
try {
    npm.cmd run contracts:schedule-nft-v2-chest-batch-upgrade:ronin
    if ($LASTEXITCODE -ne 0) { throw "Chest batch upgrade scheduling failed with exit code $LASTEXITCODE." }
    Write-Host "`nThe Chest batch upgrade is scheduled. Save the displayed Ready at UTC time." -ForegroundColor Green
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
