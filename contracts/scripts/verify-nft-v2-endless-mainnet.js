import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import hre, { network } from "hardhat";
import { verifyContract } from "@nomicfoundation/hardhat-verify/verify";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  ENDLESS_MAINNET_CONFIG_PATH
} from "./lib/nft-v2-endless-mainnet.js";

const RONIN_EXPLORER_CONTRACT_API = "https://explorer.roninchain.com/api/v2/smart-contracts";

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
  const explorerResult = await readRoninExplorerVerification(record.address);
  if (isExactExplorerMatch(explorerResult, record)) {
    const checkedAt = new Date().toISOString();
    record.sourceVerifiedAt = checkedAt;
    record.roninExplorerVerification = {
      contractName: explorerResult.name,
      compilerVersion: explorerResult.compiler_version,
      verifiedAt: explorerResult.verified_at,
      checkedAt,
      isFullyVerified: true,
      isPartiallyVerified: false,
      creationStatus: "success"
    };
    console.log(`${label}: exact Ronin Explorer match confirmed`);
    save();
    continue;
  }
  console.log(`${label}: no exact Ronin Explorer match; submitting the production build to Sourcify V2...`);
  await verifyContract({
    address: record.address,
    constructorArgs: record.constructorArgs,
    creationTxHash: record.transactionHash,
    provider: "sourcify"
  }, hre);
  record.sourcifySubmittedAt = new Date().toISOString();
  save();
  throw new Error(
    `${label} was submitted to Sourcify but is not yet an exact Ronin Explorer match. ` +
    "Run npm.cmd run export-nft-v2-endless-verification-inputs, upload the matching Standard JSON input in Ronin Explorer, then rerun this command."
  );
}
manifest.sourceVerifiedAt = new Date().toISOString();
manifest.updatedAt = manifest.sourceVerifiedAt;
save();
console.log("Both MATT Mine Endless contracts have exact Ronin Explorer source matches.");
console.log("No transaction was broadcast and Endless activation state was unchanged.");

async function readRoninExplorerVerification(address) {
  const response = await fetch(`${RONIN_EXPLORER_CONTRACT_API}/${address}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Ronin Explorer verification lookup failed for ${address}: HTTP ${response.status}.`);
  }
  return response.json();
}

function isExactExplorerMatch(result, record) {
  return result?.is_verified === true &&
    result.is_fully_verified === true &&
    result.is_partially_verified === false &&
    result.creation_status === "success" &&
    result.name === record.artifactName;
}

function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
