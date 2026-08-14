$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
$repositoryDirectory = Resolve-Path (Join-Path $contractsDirectory "..")
Set-Location -LiteralPath $repositoryDirectory

try {
    npm.cmd run contracts:verify-nft-v2:ronin
    if ($LASTEXITCODE -ne 0) { throw "Sourcify verification failed with exit code $LASTEXITCODE." }
    npm.cmd run contracts:check-nft-v2:ronin
    if ($LASTEXITCODE -ne 0) { throw "Read-only verification failed with exit code $LASTEXITCODE." }
    Write-Host "`nAll NFT V2 sources and proxy implementations are verified. Contracts remain PAUSED." -ForegroundColor Green
    $exitCode = 0
}
catch {
    Write-Host "`nVerification stopped safely: $($_.Exception.Message)" -ForegroundColor Yellow
    $exitCode = 1
}

Read-Host "Press Enter to close this secure verification window"
exit $exitCode
