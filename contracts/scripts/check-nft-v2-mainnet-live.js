import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, getAddress } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CONFIG_PATH,
  NFT_V2_ROOT,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";

const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (manifest.status !== "activated" || !manifest.activatedAt) throw new Error("NFT V2 activation is not recorded in the deployment manifest.");

const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address);
const miner = await at("MattV2Miner", "Miner");
const equipment = await at("MattV2Equipment", "Equipment");
const loadout = await at("MattV2Loadout", "Loadout");
const bank = await at("MattV2CrystalBank", "CrystalBankProxy");
const passive = await at("MattV2PassiveRewards", "PassiveRewardsProxy");
const settlement = await at("MattV2GameSettlement", "GameSettlementProxy");
const chest = await at("MattV2Chest", "ChestProxy");
const modules = { miner, equipment, loadout, bank, passive, settlement, chest };

for (const [label, contract] of Object.entries(modules)) {
  if (await contract.paused()) throw new Error(`${label} is paused.`);
  if (getAddress(await contract.defaultAdmin()) !== NFT_V2_ROOT) throw new Error(`${label} default admin mismatch.`);
}
const salesWallet = getAddress(manifest.marketInventory?.salesWallet || "");
if (
  await miner.nextTokenId() !== 1_001n || await miner.balanceOf(salesWallet) !== 1_000n
  || getAddress(await miner.ownerOf(1n)) !== salesWallet || getAddress(await miner.ownerOf(1_000n)) !== salesWallet
) throw new Error("The 1,000-Miner marketplace inventory changed unexpectedly.");

for (const [label, contract, role, account] of [
  ["Miner emergency pauser", miner, await miner.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Equipment emergency pauser", equipment, await equipment.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Loadout emergency pauser", loadout, await loadout.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Bank emergency pauser", bank, await bank.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Passive emergency pauser", passive, await passive.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Settlement emergency pauser", settlement, await settlement.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Chest emergency pauser", chest, await chest.PAUSER_ROLE(), config.activationRoles.emergencyPauser],
  ["Game operator", settlement, await settlement.OPERATOR_ROLE(), config.activationRoles.gameOperator],
  ["Passive keeper", passive, await passive.KEEPER_ROLE(), config.activationRoles.keeper],
  ["Loadout config operator", loadout, await loadout.CONFIG_ROLE(), config.activationRoles.configOperator],
  ["Bank config operator", bank, await bank.CONFIG_ROLE(), config.activationRoles.configOperator],
  ["Settlement config operator", settlement, await settlement.CONFIG_ROLE(), config.activationRoles.configOperator],
  ["Chest config operator", chest, await chest.CONFIG_ROLE(), config.activationRoles.configOperator]
]) if (!(await contract.hasRole(role, account))) throw new Error(`${label} role is missing.`);

for (const [label, contract, role, account] of [
  ["Settlement progression", miner, await miner.PROGRESSION_ROLE(), settlement.target],
  ["Settlement run lock", miner, await miner.LOCK_ROLE(), settlement.target],
  ["Passive rate assignment", miner, await miner.PASSIVE_ROLE(), passive.target],
  ["Loadout metadata refresh", miner, await miner.METADATA_ROLE(), loadout.target],
  ["Chest equipment mint", equipment, await equipment.MINTER_ROLE(), chest.target],
  ["Loadout equipment assignment", equipment, await equipment.LOADOUT_ROLE(), loadout.target],
  ["Loadout armor state", equipment, await equipment.STATE_ROLE(), loadout.target],
  ["Loadout backpack burn", equipment, await equipment.BURNER_ROLE(), loadout.target],
  ["Settlement loadout game", loadout, await loadout.GAME_ROLE(), settlement.target],
  ["Settlement bank credit", bank, await bank.CREDIT_ROLE(), settlement.target],
  ["Settlement passive scheduling", passive, await passive.SETTLEMENT_ROLE(), settlement.target]
]) if (!(await contract.hasRole(role, account))) throw new Error(`${label} system role is missing.`);

for (const [label, contract, role] of [
  ["Miner mint", miner, await miner.MINTER_ROLE()],
  ["Miner progression", miner, await miner.PROGRESSION_ROLE()],
  ["Miner lock", miner, await miner.LOCK_ROLE()],
  ["Miner passive", miner, await miner.PASSIVE_ROLE()],
  ["Equipment mint", equipment, await equipment.MINTER_ROLE()],
  ["Equipment loadout", equipment, await equipment.LOADOUT_ROLE()],
  ["Equipment state", equipment, await equipment.STATE_ROLE()],
  ["Equipment burn", equipment, await equipment.BURNER_ROLE()],
  ["Loadout game", loadout, await loadout.GAME_ROLE()],
  ["Bank credit", bank, await bank.CREDIT_ROLE()],
  ["Passive settlement", passive, await passive.SETTLEMENT_ROLE()],
  ["Passive keeper", passive, await passive.KEEPER_ROLE()],
  ["Settlement operator", settlement, await settlement.OPERATOR_ROLE()],
  ["Loadout config", loadout, await loadout.CONFIG_ROLE()],
  ["Bank config", bank, await bank.CONFIG_ROLE()],
  ["Settlement config", settlement, await settlement.CONFIG_ROLE()],
  ["Chest config", chest, await chest.CONFIG_ROLE()]
]) if (await contract.hasRole(role, NFT_V2_ROOT)) throw new Error(`Root still has the routine ${label} role.`);

if (getAddress(await settlement.rewardSigner()) !== config.activationRoles.rewardSigner) throw new Error("Reward Signer mismatch.");
const crystal = new Contract(config.protocol.crystalToken, [
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)"
], ethers.provider);
const crystalMinterRole = await crystal.MINTER_ROLE();
for (const target of [bank.target, passive.target]) {
  if (!(await crystal.hasRole(crystalMinterRole, target))) throw new Error(`${target} is not a Crystal minter.`);
}
const coordinator = new Contract(config.protocol.vrfCoordinator, [
  "function getSubscription(uint256 subId) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)"
], ethers.provider);
const subscription = await coordinator.getSubscription(config.protocol.vrfSubscriptionId);
for (const adapter of [manifest.contracts.ChestRandomness.address, manifest.contracts.PassiveRandomness.address]) {
  if (!(subscription.consumers ?? subscription[4]).some((value) => getAddress(value) === getAddress(adapter))) {
    throw new Error(`${adapter} is not a VRF subscription consumer.`);
  }
}

console.log("Ronin Mainnet NFT V2 live-state verification passed.");
console.log("All seven modules are live, production roles are separated, VRF and Crystal authority are active, and all 1,000 Miners remain in marketplace inventory.");
