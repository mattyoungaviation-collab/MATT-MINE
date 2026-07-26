import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import {
  DEPLOYMENT_PATH,
  RONIN_CHAIN_ID,
  loadDeploymentManifest,
  writeDeploymentManifest
} from "./lib/mainnet-config.js";

const { ethers } = await network.create();
const connectedNetwork = await ethers.provider.getNetwork();
if (connectedNetwork.chainId !== RONIN_CHAIN_ID) {
  throw new Error(`Verification must use Ronin Mainnet ${RONIN_CHAIN_ID}`);
}

const manifest = loadDeploymentManifest();
if (manifest === null || manifest.status === "partial") {
  throw new Error("No complete Ronin deployment record is available");
}
if (manifest.chainId !== Number(RONIN_CHAIN_ID)) {
  throw new Error("Deployment record is not for Ronin Mainnet");
}

const expectedContracts = [
  "MattMinePass",
  "MattMineSwapExecutor",
  "MattMineRewards",
  "MattMineRuns"
];
for (const label of expectedContracts) {
  if (!manifest.contracts[label]?.address) {
    throw new Error(`Deployment record is missing ${label}`);
  }
}

for (const [label, deployment] of Object.entries(manifest.contracts)) {
  if ((await ethers.provider.getCode(deployment.address)) === "0x") {
    throw new Error(`${label} has no code at ${deployment.address}`);
  }
  if (deployment.sourcifyVerifiedAt) {
    console.log(`${label}: already recorded as verified`);
    continue;
  }

  console.log(`${label}: submitting to Sourcify for Ronin Mainnet...`);
  await verifyContract(
    {
      address: deployment.address,
      constructorArgs: deployment.constructorArgs,
      provider: "sourcify"
    },
    hre
  );
  deployment.sourcifyVerifiedAt = new Date().toISOString();
  writeDeploymentManifest(manifest);
}

manifest.status = "verified";
manifest.verifiedAt = new Date().toISOString();
manifest.updatedAt = manifest.verifiedAt;
writeDeploymentManifest(manifest);

console.log("All MATT Mine contracts are verified on Sourcify for Ronin Mainnet.");
console.log(`Deployment record: ${DEPLOYMENT_PATH}`);
