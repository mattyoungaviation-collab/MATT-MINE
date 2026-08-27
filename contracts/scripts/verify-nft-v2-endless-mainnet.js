import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  ENDLESS_MAINNET_CONFIG_PATH
} from "./lib/nft-v2-endless-mainnet.js";

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) {
  throw new Error("Endless source verification requires Ronin Mainnet chain 2020.");
}
const deploymentPath = process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(ENDLESS_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-endless-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (!String(manifest.status || "").startsWith("deployed_configured_paused") && manifest.status !== "activated") {
  throw new Error(`Cannot verify incomplete Endless deployment status ${manifest.status}.`);
}

for (const [label, record] of Object.entries(manifest.contracts || {})) {
  if ((await ethers.provider.getCode(record.address)) === "0x") throw new Error(`${label} has no Ronin contract code.`);
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
manifest.sourceVerifiedAt = new Date().toISOString();
manifest.updatedAt = manifest.sourceVerifiedAt;
save();
console.log("Both MATT Mine Endless contracts were submitted to Ronin Sourcify.");
console.log("No transaction was broadcast and Endless activation state was unchanged.");

function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
