import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  loadActivatedNftV2Base,
  loadEndlessMainnetConfig
} from "./lib/nft-v2-endless-mainnet.js";

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) throw new Error("Endless verification requires Ronin Mainnet chain 2020.");
const config = loadEndlessMainnetConfig();
const base = loadActivatedNftV2Base(config);
const deploymentPath = process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(config.configPath), "..", "deployments", "nft-v2-endless-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (!String(manifest.status || "").startsWith("deployed_configured_paused") && manifest.status !== "activated") {
  throw new Error("Endless deployment is not fully configured.");
}
for (const [key, address] of Object.entries(base.contracts)) {
  if (getAddress(manifest.baseContracts?.[key]) !== address) throw new Error(`Endless base ${key} address drifted.`);
}
const proxy = getAddress(manifest.contracts?.EndlessSettlementProxy?.address || "");
if ((await ethers.provider.getCode(proxy)) === "0x") throw new Error("Endless proxy has no code.");
const endless = await ethers.getContractAt("MattV2EndlessSettlement", proxy);
const miner = await ethers.getContractAt("MattV2Miner", base.contracts.miner);
const loadout = await ethers.getContractAt("MattV2Loadout", base.contracts.loadout);
const bank = await ethers.getContractAt("MattV2CrystalBank", base.contracts.crystalBank);
const passive = await ethers.getContractAt("MattV2PassiveRewards", base.contracts.passiveRewards);

if (getAddress(await endless.defaultAdmin()) !== config.roles.rootAdmin) throw new Error("Endless default admin mismatch.");
if (getAddress(await endless.rewardSigner()) !== config.roles.rewardSigner) throw new Error("Endless Reward Signer mismatch.");
for (const [label, contract, role, account] of [
  ["operator", endless, await endless.OPERATOR_ROLE(), config.roles.gameOperator],
  ["config", endless, await endless.CONFIG_ROLE(), config.roles.configOperator],
  ["pauser", endless, await endless.PAUSER_ROLE(), config.roles.emergencyPauser],
  ["Miner progression", miner, await miner.PROGRESSION_ROLE(), proxy],
  ["Miner lock", miner, await miner.LOCK_ROLE(), proxy],
  ["Loadout game", loadout, await loadout.GAME_ROLE(), proxy],
  ["Bank credit", bank, await bank.CREDIT_ROLE(), proxy],
  ["Passive settlement", passive, await passive.SETTLEMENT_ROLE(), proxy]
]) if (!(await contract.hasRole(role, account))) throw new Error(`Endless ${label} role is missing.`);
for (const [label, role] of [
  ["operator", await endless.OPERATOR_ROLE()],
  ["config", await endless.CONFIG_ROLE()],
  ["pauser", await endless.PAUSER_ROLE()]
]) if (await endless.hasRole(role, config.roles.rootAdmin)) throw new Error(`Root still has the routine Endless ${label} role.`);
for (const [economyVersion, version] of Object.entries(config.versions)) {
  const onchain = await endless.versions(version.versionId);
  if (!onchain.approved || onchain.retired) throw new Error(`${economyVersion} is not an active Endless version.`);
  if (manifest.versionIds?.[economyVersion] !== version.versionId) throw new Error(`${economyVersion} route differs from the manifest.`);
}
const paused = await endless.paused();
if (manifest.status === "activated" && paused) throw new Error("Activated Endless settlement is paused.");
if (manifest.status !== "activated" && !paused) throw new Error("Unactivated Endless settlement is unexpectedly live.");

console.log(`Endless Ronin verification passed in ${paused ? "PAUSED" : "LIVE"} state.`);
console.log(`Settlement: ${proxy}`);
console.log(`Version routes: ${JSON.stringify(manifest.versionIds)}`);
