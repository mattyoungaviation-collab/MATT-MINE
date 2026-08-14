import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, parseEther } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CONFIG_PATH,
  NFT_V2_ROOT,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";

const CONFIRMATION = "ACTIVATE_MATT_MINE_NFT_V2_ON_RONIN_MAINNET";
if (process.env.MATT_MINE_NFT_V2_MAINNET_ACTIVATION !== CONFIRMATION) throw new Error(`Set MATT_MINE_NFT_V2_MAINNET_ACTIVATION=${CONFIRMATION}.`);
const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const [admin, ...extra] = await ethers.getSigners();
if (!admin || extra.length || getAddress(await admin.getAddress()) !== NFT_V2_ROOT) throw new Error("Activation requires only the encrypted 0xF799 NUGG key.");
const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (manifest.status !== "market_inventory_minted_paused") {
  throw new Error("Pre-mint all 1,000 Miners to the marketplace inventory wallet before activation.");
}
const transactions = [];
const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address, admin);
const miner = await at("MattV2Miner", "Miner");
const equipment = await at("MattV2Equipment", "Equipment");
const loadout = await at("MattV2Loadout", "Loadout");
const bank = await at("MattV2CrystalBank", "CrystalBankProxy");
const passive = await at("MattV2PassiveRewards", "PassiveRewardsProxy");
const settlement = await at("MattV2GameSettlement", "GameSettlementProxy");
const chest = await at("MattV2Chest", "ChestProxy");
const salesWallet = getAddress(manifest.marketInventory?.salesWallet || "");
if (
  await miner.nextTokenId() !== 1_001n || await miner.balanceOf(salesWallet) !== 1_000n
  || getAddress(await miner.ownerOf(1n)) !== salesWallet || getAddress(await miner.ownerOf(1_000n)) !== salesWallet
) throw new Error("Marketplace inventory ownership is incomplete.");
const crystal = new ethers.Contract(config.protocol.crystalToken, [
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function owner() view returns (address)",
  "function grantMinter(address)"
], admin);
if (getAddress(await crystal.owner()) !== NFT_V2_ROOT) {
  throw new Error("0xF799 is not the MATT Crystal owner and cannot authorize the V2 payout contracts.");
}
const coordinator = new ethers.Contract(config.protocol.vrfCoordinator, [
  "function getSubscription(uint256 subId) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)",
  "function addConsumer(uint256 subId,address consumer)"
], admin);
const adapters = [manifest.contracts.ChestRandomness.address, manifest.contracts.PassiveRandomness.address];
let subscription = await coordinator.getSubscription(config.protocol.vrfSubscriptionId);
if (getAddress(subscription.subOwner ?? subscription[3]) !== NFT_V2_ROOT) throw new Error("0xF799 is not the VRF subscription owner.");
for (const adapter of adapters) {
  if (!(subscription.consumers ?? subscription[4]).some((value) => getAddress(value) === getAddress(adapter))) {
    await coordinator.addConsumer.staticCall(config.protocol.vrfSubscriptionId, adapter);
  }
}
const minterRole = await crystal.MINTER_ROLE();
for (const target of [bank.target, passive.target]) {
  if (!(await crystal.hasRole(minterRole, target))) {
    try { await crystal.grantMinter.staticCall(target); }
    catch (error) { throw new Error(`0xF799 cannot authorize ${target} as a Crystal minter through the token owner's grantMinter function. ${error.shortMessage || error.message}`); }
  }
}
for (const [label, address] of [["Game/Config Operator", config.activationRoles.gameOperator], ["Keeper", config.activationRoles.keeper]]) {
  if (await ethers.provider.getBalance(address) < parseEther("0.05")) throw new Error(`${label} ${address} needs at least 0.05 RON.`);
}
if (await ethers.provider.getBalance(NFT_V2_ROOT) < parseEther("1")) throw new Error("0xF799 needs at least 1 RON.");
for (const adapter of adapters) {
  if (!(subscription.consumers ?? subscription[4]).some((value) => getAddress(value) === getAddress(adapter))) {
    await send(`Add VRF consumer ${adapter}`, () => coordinator.addConsumer(config.protocol.vrfSubscriptionId, adapter));
    subscription = await coordinator.getSubscription(config.protocol.vrfSubscriptionId);
  }
}
for (const target of [bank.target, passive.target]) {
  if (!(await crystal.hasRole(minterRole, target))) await send(`Authorize Crystal minter ${target}`, () => crystal.grantMinter(target));
}

await grant(miner, await miner.PAUSER_ROLE(), config.activationRoles.emergencyPauser, "Miner emergency pauser");
await grant(equipment, await equipment.PAUSER_ROLE(), config.activationRoles.emergencyPauser, "Equipment emergency pauser");
await grant(loadout, await loadout.PAUSER_ROLE(), config.activationRoles.emergencyPauser, "Loadout emergency pauser");
for (const module of [bank, passive, settlement, chest]) await grant(module, await module.PAUSER_ROLE(), config.activationRoles.emergencyPauser, "Upgradeable module emergency pauser");
await grant(settlement, await settlement.OPERATOR_ROLE(), config.activationRoles.gameOperator, "Dedicated Game Operator");
await sendIf(getAddress(await settlement.rewardSigner()) !== config.activationRoles.rewardSigner, "Dedicated Reward Signer", () => settlement.setRewardSigner(config.activationRoles.rewardSigner));
await grant(passive, await passive.KEEPER_ROLE(), config.activationRoles.keeper, "Passive payout Keeper");
for (const module of [loadout, bank, settlement, chest]) await grant(module, await module.CONFIG_ROLE(), config.activationRoles.configOperator, "Dedicated Config Operator");

await revoke(miner, await miner.MINTER_ROLE(), NFT_V2_ROOT, "Revoke root Miner mint role");
await revoke(miner, await miner.PROGRESSION_ROLE(), NFT_V2_ROOT, "Revoke root Miner progression role");
await revoke(miner, await miner.LOCK_ROLE(), NFT_V2_ROOT, "Revoke root Miner lock role");
await revoke(miner, await miner.PASSIVE_ROLE(), NFT_V2_ROOT, "Revoke root Miner passive role");
await revoke(equipment, await equipment.MINTER_ROLE(), NFT_V2_ROOT, "Revoke root Equipment mint role");
await revoke(equipment, await equipment.LOADOUT_ROLE(), NFT_V2_ROOT, "Revoke root Equipment loadout role");
await revoke(equipment, await equipment.STATE_ROLE(), NFT_V2_ROOT, "Revoke root Equipment state role");
await revoke(equipment, await equipment.BURNER_ROLE(), NFT_V2_ROOT, "Revoke root Equipment burn role");
await revoke(loadout, await loadout.GAME_ROLE(), NFT_V2_ROOT, "Revoke root Loadout game role");
await revoke(bank, await bank.CREDIT_ROLE(), NFT_V2_ROOT, "Revoke root Bank credit role");
await revoke(passive, await passive.SETTLEMENT_ROLE(), NFT_V2_ROOT, "Revoke root Passive settlement role");
await revoke(passive, await passive.KEEPER_ROLE(), NFT_V2_ROOT, "Revoke root Keeper role");
await revoke(settlement, await settlement.OPERATOR_ROLE(), NFT_V2_ROOT, "Revoke root Game Operator role");
for (const module of [loadout, bank, settlement, chest]) await revoke(module, await module.CONFIG_ROLE(), NFT_V2_ROOT, "Revoke root Config role");

for (const contract of [miner, equipment, loadout, bank, passive, settlement, chest]) {
  if (await contract.paused()) await send(`Unpause ${contract.target}`, () => contract.unpause?.() ?? contract.unpauseMinting());
}
manifest.status = "activated";
manifest.activatedAt = new Date().toISOString();
manifest.activationTransactions = transactions;
save();
console.log("MATT Mine NFT V2 is activated with separated routine roles.");
console.log(`All 1,000 pre-minted Miners remain in marketplace inventory ${salesWallet}.`);

async function grant(contract, role, account, label) { await sendIf(!(await contract.hasRole(role, account)), label, () => contract.grantRole(role, account)); }
async function revoke(contract, role, account, label) { await sendIf(await contract.hasRole(role, account), label, () => contract.revokeRole(role, account)); }
async function sendIf(condition, label, factory) { if (condition) await send(label, factory); }
async function send(label, factory) {
  const tx = await factory();
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed.`);
  transactions.push({ label, hash: tx.hash, blockNumber: receipt.blockNumber });
  console.log(`${label}: ${tx.hash}`);
}
function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
