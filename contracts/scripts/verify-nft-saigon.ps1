$ErrorActionPreference = "Stop"
$contractsDirectory = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $contractsDirectory

$manifestPath = Join-Path $contractsDirectory "deployments\nft-saigon.json"
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.chainId -ne 202601 -or $manifest.scope -ne "MattMineNftV1Saigon") {
    throw "The deployment manifest is not the MATT Mine NFT Saigon release."
}

$contractIdentifiers = @{
    MattMineSaigonMatt = "src/nft/testnet/MattMineSaigonMatt.sol:MattMineSaigonMatt"
    MattMineSaigonCrystal = "src/nft/testnet/MattMineSaigonCrystal.sol:MattMineSaigonCrystal"
    MattMineSaigonRandomness = "src/nft/testnet/MattMineSaigonRandomness.sol:MattMineSaigonRandomness"
    MattMiner = "src/nft/MattMiner.sol:MattMiner"
    MattEquipment = "src/nft/MattEquipment.sol:MattEquipment"
    MattLoadout = "src/nft/MattLoadout.sol:MattLoadout"
    MattChest = "src/nft/MattChest.sol:MattChest"
    MattGameSettlement = "src/nft/MattGameSettlement.sol:MattGameSettlement"
    MattCrystalRedemption = "src/nft/MattCrystalRedemption.sol:MattCrystalRedemption"
}

foreach ($property in $manifest.contracts.psobject.Properties) {
    $name = $property.Name
    $record = $property.Value
    $identifier = $contractIdentifiers[$name]
    if (-not $identifier) {
        throw "No source identifier is configured for $name."
    }

    Write-Host "Verifying $name at $($record.address)..." -ForegroundColor Cyan
    $arguments = @(
        "hardhat",
        "--network", "saigonReadOnly",
        "--build-profile", "production",
        "verify", "sourcify",
        "--contract", $identifier,
        "--creation-tx-hash", $record.transactionHash,
        "--",
        $record.address
    )
    foreach ($constructorArgument in $record.constructorArgs) {
        $arguments += [string]$constructorArgument
    }
    & npx.cmd @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Source verification failed for $name with exit code $LASTEXITCODE."
    }
}

Write-Host "All nine Saigon NFT contracts are source verified." -ForegroundColor Green
