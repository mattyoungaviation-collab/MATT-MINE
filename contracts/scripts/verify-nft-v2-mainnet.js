import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import {
  NFT_V2_MAINNET_CHAIN_ID,
  NFT_V2_MAINNET_CONFIG_PATH
} from "./lib/nft-v2-mainnet.js";

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== NFT_V2_MAINNET_CHAIN_ID) throw new Error("Verification must use Ronin Mainnet 2020.");
const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (!String(manifest.status || "").startsWith("deployed_configured_paused") && manifest.status !== "verified_paused") {
  throw new Error(`Cannot verify incomplete deployment status ${manifest.status}.`);
}
for (const [label, record] of Object.entries(manifest.contracts)) {
  if ((await ethers.provider.getCode(record.address)) === "0x") throw new Error(`${label} has no code.`);
  if (record.sourcifyVerifiedAt) {
    console.log(`${label}: already recorded as verified`);
    continue;
  }
  console.log(`${label}: submitting exact production build to Ronin Sourcify...`);
  await verifyContract({
    address: record.address,
    constructorArgs: record.constructorArgs,
    creationTxHash: record.transactionHash,
    provider: "sourcify"
  }, hre);
  record.sourcifyVerifiedAt = new Date().toISOString();
  save();
}
manifest.status = "verified_paused";
manifest.verifiedAt = new Date().toISOString();
manifest.updatedAt = manifest.verifiedAt;
save();
console.log("All fourteen MATT Mine NFT V2 contracts were submitted to Ronin Sourcify.");
console.log("No on-chain transaction was broadcast by verification.");

function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
