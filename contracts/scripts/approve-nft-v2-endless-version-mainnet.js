import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  loadEndlessMainnetConfig
} from "./lib/nft-v2-endless-mainnet.js";

const CONFIRMATION = "APPROVE_MATT_MINE_ENDLESS_VERSION_ON_RONIN_MAINNET";
if (process.env.MATT_MINE_ENDLESS_VERSION_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_ENDLESS_VERSION_CONFIRMATION=${CONFIRMATION} after the read-only preflight passes.`);
}
const targetName = String(process.env.MATT_MINE_ENDLESS_VERSION_NAME || "endless-one-to-one-v1").trim();
const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) {
  throw new Error("Endless version approval requires Ronin Mainnet chain 2020.");
}
const config = loadEndlessMainnetConfig();
const target = config.versions[targetName];
if (!target) throw new Error(`Unknown Endless version ${targetName}. Add it to ${config.configPath} first.`);
const [admin, ...extra] = await ethers.getSigners();
if (!admin || extra.length || getAddress(await admin.getAddress()) !== config.roles.rootAdmin) {
  throw new Error(`Configure only the encrypted Root admin key ${config.roles.rootAdmin}.`);
}
const deploymentPath = process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(config.configPath), "..", "deployments", "nft-v2-endless-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (manifest.scope !== "MattMineNftV2EndlessRonin" || Number(manifest.chainId) !== Number(ENDLESS_MAINNET_CHAIN_ID)) {
  throw new Error("The Endless deployment manifest is for another release or chain.");
}
const proxy = getAddress(manifest.contracts?.EndlessSettlementProxy?.address || "");
if ((await ethers.provider.getCode(proxy)) === "0x") throw new Error("Endless Settlement proxy has no Ronin code.");
const endless = await ethers.getContractAt("MattV2EndlessSettlement", proxy, admin);
if (getAddress(await endless.defaultAdmin()) !== config.roles.rootAdmin) throw new Error("Endless Root admin mismatch.");
const configRole = await endless.CONFIG_ROLE();
if (!(await endless.hasRole(configRole, config.roles.configOperator))) throw new Error("The dedicated Endless Config Operator role is missing.");
manifest.versionTransactions ||= [];

let state = await endless.versions(target.versionId);
if (state.retired) throw new Error(`${targetName} already exists but was permanently retired.`);
try {
  if (!state.approved) {
    if (!(await endless.hasRole(configRole, config.roles.rootAdmin))) {
      await send("Temporarily grant Root Endless config", () => endless.grantRole(configRole, config.roles.rootAdmin));
    }
    await send(`Approve ${targetName}`, () => endless.approveVersion(target.input));
    state = await endless.versions(target.versionId);
    if (!state.approved || state.retired) throw new Error(`${targetName} was not approved correctly.`);
  }
} finally {
  if (await endless.hasRole(configRole, config.roles.rootAdmin)) {
    await send("Revoke temporary Root Endless config", () => endless.revokeRole(configRole, config.roles.rootAdmin));
  }
}
if (await endless.hasRole(configRole, config.roles.rootAdmin)) throw new Error("Root still has the routine Endless Config role.");
manifest.versionIds ||= {};
manifest.versionIds[targetName] = target.versionId;
manifest.requiredEnvironment ||= {};
manifest.requiredEnvironment.MATT_MINE_ENDLESS_VERSION_IDS_JSON = JSON.stringify(manifest.versionIds);
manifest.updatedAt = new Date().toISOString();
save();

console.log(`Endless version approved: ${targetName}`);
console.log(`Version ID: ${target.versionId}`);
console.log(`Settlement: ${proxy}`);
console.log(`Version routes: ${JSON.stringify(manifest.versionIds)}`);
console.log(`Manifest updated: ${deploymentPath}`);

async function send(label, operation) {
  const transaction = await operation();
  console.log(`${label}: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} reverted.`);
  manifest.versionTransactions.push({ label, hash: transaction.hash, blockNumber: receipt.blockNumber });
  save();
}

function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
