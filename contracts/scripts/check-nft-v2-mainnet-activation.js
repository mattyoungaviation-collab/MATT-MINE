import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Contract, getAddress, parseEther } from "ethers";
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
const [admin, ...extra] = await ethers.getSigners();
if (!admin || extra.length || getAddress(await admin.getAddress()) !== NFT_V2_ROOT) {
  throw new Error("Activation readiness requires only the encrypted 0xF799 NUGG key.");
}
const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (manifest.status !== "market_inventory_minted_paused") {
  throw new Error("All 1,000 Miners must be pre-minted to the marketplace inventory wallet first.");
}

const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address, admin);
const miner = await at("MattV2Miner", "Miner");
const equipment = await at("MattV2Equipment", "Equipment");
const loadout = await at("MattV2Loadout", "Loadout");
const bank = await at("MattV2CrystalBank", "CrystalBankProxy");
const passive = await at("MattV2PassiveRewards", "PassiveRewardsProxy");
const settlement = await at("MattV2GameSettlement", "GameSettlementProxy");
const chest = await at("MattV2Chest", "ChestProxy");
for (const contract of [miner, equipment, loadout, bank, passive, settlement, chest]) {
  if (!(await contract.paused())) throw new Error(`${contract.target} must remain paused before activation.`);
}
const salesWallet = getAddress(manifest.marketInventory?.salesWallet || "");
if (
  await miner.nextTokenId() !== 1_001n || await miner.balanceOf(salesWallet) !== 1_000n
  || getAddress(await miner.ownerOf(1n)) !== salesWallet || getAddress(await miner.ownerOf(1_000n)) !== salesWallet
) throw new Error("Marketplace inventory ownership is incomplete.");

const crystal = new Contract(config.protocol.crystalToken, [
  "function MINTER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32,address) view returns (bool)",
  "function grantRole(bytes32,address)"
], admin);
const coordinator = new Contract(config.protocol.vrfCoordinator, [
  "function getSubscription(uint256 subId) view returns (uint96 balance,uint96 nativeBalance,uint64 reqCount,address subOwner,address[] consumers)",
  "function addConsumer(uint256 subId,address consumer)"
], admin);
const subscription = await coordinator.getSubscription(config.protocol.vrfSubscriptionId);
if (getAddress(subscription.subOwner ?? subscription[3]) !== NFT_V2_ROOT) {
  throw new Error("0xF799 is not the configured VRF subscription owner.");
}
for (const adapter of [manifest.contracts.ChestRandomness.address, manifest.contracts.PassiveRandomness.address]) {
  if (!(subscription.consumers ?? subscription[4]).some((value) => getAddress(value) === getAddress(adapter))) {
    await coordinator.addConsumer.staticCall(config.protocol.vrfSubscriptionId, adapter);
  }
}
const minterRole = await crystal.MINTER_ROLE();
for (const target of [bank.target, passive.target]) {
  if (!(await crystal.hasRole(minterRole, target))) {
    try {
      await crystal.grantRole.staticCall(minterRole, target);
    } catch (error) {
      throw new Error(`0xF799 cannot grant Crystal MINTER_ROLE to ${target}. Restore the Crystal AccessControl admin before activation. ${error.shortMessage || error.message}`);
    }
  }
}
for (const [label, address] of [
  ["Game Operator / Config Operator", config.activationRoles.gameOperator],
  ["Passive Rewards Keeper", config.activationRoles.keeper]
]) {
  if (await ethers.provider.getBalance(address) < parseEther("0.05")) throw new Error(`${label} ${address} needs at least 0.05 RON for activation.`);
}
if (await ethers.provider.getBalance(NFT_V2_ROOT) < parseEther("1")) throw new Error("0xF799 needs at least 1 RON for activation transactions.");

console.log("NFT V2 activation readiness passed without broadcasting a transaction.");
console.log(`Marketplace inventory wallet: ${salesWallet}`);
console.log("All 1,000 Miners, VRF ownership, Crystal mint authority, dedicated-wallet fuel, paused state, source verification, and manifest status are ready.");
