import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, parseEther } from "ethers";
import { network } from "hardhat";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  loadEndlessMainnetConfig
} from "./lib/nft-v2-endless-mainnet.js";

const targetName = String(process.env.MATT_MINE_ENDLESS_VERSION_NAME || "endless-one-to-one-v1").trim();
const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) {
  throw new Error("Endless version preflight requires Ronin Mainnet chain 2020.");
}
const config = loadEndlessMainnetConfig();
const target = config.versions[targetName];
if (!target) throw new Error(`Unknown Endless version ${targetName}. Add it to ${config.configPath} first.`);
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
const endless = await ethers.getContractAt("MattV2EndlessSettlement", proxy);
if (getAddress(await endless.defaultAdmin()) !== config.roles.rootAdmin) throw new Error("Endless Root admin mismatch.");
const configRole = await endless.CONFIG_ROLE();
if (!(await endless.hasRole(configRole, config.roles.configOperator))) throw new Error("The dedicated Endless Config Operator role is missing.");
const state = await endless.versions(target.versionId);
if (state.retired) throw new Error(`${targetName} already exists but was permanently retired.`);
const latest = await ethers.provider.getTransactionCount(config.roles.rootAdmin, "latest");
const pending = await ethers.provider.getTransactionCount(config.roles.rootAdmin, "pending");
if (latest !== pending) throw new Error("The Root admin wallet has pending transactions.");
const balance = await ethers.provider.getBalance(config.roles.rootAdmin);
if (!state.approved && balance < parseEther("0.05")) throw new Error("The Root admin wallet needs at least 0.05 RON.");
const routes = { ...(manifest.versionIds || {}), [targetName]: target.versionId };

console.log(`Endless ${targetName} Ronin preflight passed. No transaction was broadcast.`);
console.log(`Settlement: ${proxy}`);
console.log(`Required Root admin: ${config.roles.rootAdmin}`);
console.log(`Balance: ${ethers.formatEther(balance)} RON`);
console.log(`Version ID: ${target.versionId}`);
console.log(`Conversion rate: ${target.input.conversionRate.toString()} wei per mined unit`);
console.log(`Already approved: ${state.approved === true}`);
console.log(`Version routes after approval: ${JSON.stringify(routes)}`);
