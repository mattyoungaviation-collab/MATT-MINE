$ErrorActionPreference = "Continue"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

$env:MATT_MINE_NFT_SAIGON_TEST_PLAYER = "0x1DAb596D0121C250a24B00137E84170FA6874be6"
$env:MATT_MINE_NFT_SAIGON_REHEARSAL_CONFIRMATION = "ACTIVATE_MATT_MINE_NFT_V1_SAIGON_REHEARSAL"
try {
    npm.cmd run contracts:bootstrap-nft-rehearsal:saigon
    $rehearsalExitCode = $LASTEXITCODE
    if ($rehearsalExitCode -eq 0) {
        npm.cmd run contracts:check-nft-rehearsal:saigon
        $rehearsalExitCode = $LASTEXITCODE
    }
}
finally {
    Remove-Item Env:MATT_MINE_NFT_SAIGON_REHEARSAL_CONFIRMATION -ErrorAction SilentlyContinue
    Remove-Item Env:MATT_MINE_NFT_SAIGON_TEST_PLAYER -ErrorAction SilentlyContinue
}

if ($rehearsalExitCode -eq 0) {
    Write-Host "`nMiner #1 and test funds are ready. The Saigon gameplay contracts are live." -ForegroundColor Green
}
else {
    Write-Host "`nRehearsal activation stopped safely with exit code $rehearsalExitCode." -ForegroundColor Yellow
}

Read-Host "Press Enter to close this secure rehearsal window"
exit $rehearsalExitCode
