import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CONFIG_PATH,
  NFT_V2_MAINNET_RELEASE_ID,
  jsonSafe,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";

const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const configHash = keccak256(toUtf8Bytes(JSON.stringify(jsonSafe(config))));
if (
  manifest.scope !== "MattMineNftV2Ronin" || manifest.releaseId !== NFT_V2_MAINNET_RELEASE_ID
  || manifest.chainId !== config.chainId || manifest.configHash !== configHash
  || !["deployed_configured_paused_requires_external_activation", "verified_paused"].includes(manifest.status)
) throw new Error("Manifest does not match the exact approved V2 mainnet release.");
for (const [label, record] of Object.entries(manifest.contracts)) {
  if ((await ethers.provider.getCode(record.address)) === "0x") throw new Error(`${label} has no code.`);
}
const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address);
const timelock = await at("MattV2UpgradeTimelock", "UpgradeTimelock");
const miner = await at("MattV2Miner", "Miner");
const equipment = await at("MattV2Equipment", "Equipment");
const chestRandomness = await at("MattMineVRFV25Adapter", "ChestRandomness");
const passiveRandomness = await at("MattMineVRFV25Adapter", "PassiveRandomness");
const loadout = await at("MattV2Loadout", "Loadout");
const bank = await at("MattV2CrystalBank", "CrystalBankProxy");
const passive = await at("MattV2PassiveRewards", "PassiveRewardsProxy");
const settlement = await at("MattV2GameSettlement", "GameSettlementProxy");
const chest = await at("MattV2Chest", "ChestProxy");

for (const [label, contract] of Object.entries({ miner, equipment, loadout, bank, passive, settlement, chest })) {
  if (!(await contract.paused())) throw new Error(`${label} is unexpectedly live.`);
  if (getAddress(await contract.defaultAdmin()) !== config.roles.rootAdmin) throw new Error(`${label} admin mismatch.`);
}
if (await timelock.UPGRADE_DELAY() !== 172_800n || getAddress(await timelock.owner()) !== config.roles.rootAdmin) throw new Error("Upgrade Timelock mismatch.");
if (await miner.MAX_SUPPLY() !== 1_000n || await miner.nextTokenId() !== 1n || await equipment.nextTokenId() !== 1n) throw new Error("Collection cap or fresh-supply guard mismatch.");
for (const [proxyLabel, implementationLabel] of [
  ["CrystalBankProxy", "CrystalBankImplementation"],
  ["PassiveRewardsProxy", "PassiveRewardsImplementation"],
  ["GameSettlementProxy", "GameSettlementImplementation"],
  ["ChestProxy", "ChestImplementation"]
]) {
  const stored = await ethers.provider.getStorage(manifest.contracts[proxyLabel].address, IMPLEMENTATION_SLOT);
  const implementation = getAddress(`0x${stored.slice(-40)}`);
  if (implementation !== getAddress(manifest.contracts[implementationLabel].address)) throw new Error(`${proxyLabel} implementation slot mismatch.`);
}
for (const module of [bank, passive, settlement, chest]) {
  if (getAddress(await module.UPGRADE_TIMELOCK()) !== getAddress(timelock.target)) throw new Error("A UUPS implementation is bound to another timelock.");
}
for (const adapter of [chestRandomness, passiveRandomness]) {
  if (getAddress(await adapter.owner()) !== config.roles.rootAdmin) throw new Error("VRF adapter owner mismatch.");
  if (getAddress(await adapter.vrfCoordinator()) !== config.protocol.vrfCoordinator) throw new Error("VRF coordinator mismatch.");
  if (await adapter.subscriptionId() !== config.protocol.vrfSubscriptionId || await adapter.keyHash() !== config.protocol.vrfKeyHash) throw new Error("VRF subscription/key mismatch.");
  if (!(await adapter.supportsRequestCancellation())) throw new Error("VRF cancellation path missing.");
}
if (getAddress(await chestRandomness.consumer()) !== getAddress(chest.target)) throw new Error("Chest VRF consumer mismatch.");
if (getAddress(await passiveRandomness.consumer()) !== getAddress(passive.target)) throw new Error("Passive VRF consumer mismatch.");
for (const [label, actual, expected] of [
  ["Loadout Miner", await loadout.miner(), miner.target], ["Loadout Equipment", await loadout.equipment(), equipment.target],
  ["Loadout MATT", await loadout.matt(), config.protocol.mattToken], ["Bank Crystal", await bank.crystal(), config.protocol.crystalToken],
  ["Passive Miner", await passive.miner(), miner.target], ["Passive Crystal", await passive.crystal(), config.protocol.crystalToken],
  ["Passive VRF", await passive.randomnessProvider(), passiveRandomness.target], ["Settlement Miner", await settlement.miner(), miner.target],
  ["Settlement Loadout", await settlement.loadout(), loadout.target], ["Settlement Bank", await settlement.crystalBank(), bank.target],
  ["Settlement Passive", await settlement.passiveRewards(), passive.target], ["Chest MATT", await chest.matt(), config.protocol.mattToken],
  ["Chest Equipment", await chest.equipment(), equipment.target], ["Chest VRF", await chest.randomnessProvider(), chestRandomness.target]
]) if (getAddress(actual) !== getAddress(expected)) throw new Error(`${label} wiring mismatch.`);
if (getAddress(await loadout.treasury()) !== config.roles.treasury || getAddress(await chest.treasury()) !== config.roles.treasury) throw new Error("Treasury wiring mismatch.");
if (await loadout.repairPrice() !== config.economy.repairPriceMattWei) throw new Error("Repair price mismatch.");
for (const [label, contract, role, account] of [
  ["Miner progression", miner, await miner.PROGRESSION_ROLE(), settlement.target],
  ["Miner lock", miner, await miner.LOCK_ROLE(), settlement.target],
  ["Miner passive", miner, await miner.PASSIVE_ROLE(), passive.target],
  ["Miner metadata", miner, await miner.METADATA_ROLE(), loadout.target],
  ["Equipment mint", equipment, await equipment.MINTER_ROLE(), chest.target],
  ["Equipment loadout", equipment, await equipment.LOADOUT_ROLE(), loadout.target],
  ["Equipment state", equipment, await equipment.STATE_ROLE(), loadout.target],
  ["Equipment burn", equipment, await equipment.BURNER_ROLE(), loadout.target],
  ["Loadout game", loadout, await loadout.GAME_ROLE(), settlement.target],
  ["Bank credit", bank, await bank.CREDIT_ROLE(), settlement.target],
  ["Passive settlement", passive, await passive.SETTLEMENT_ROLE(), settlement.target]
]) if (!(await contract.hasRole(role, account))) throw new Error(`${label} role missing.`);

const prices = [config.economy.armorChestPriceMattWei, config.economy.pickaxeChestPriceMattWei, config.economy.blasterChestPriceMattWei, config.economy.dynamiteChestPriceMattWei, config.economy.helmetChestPriceMattWei, config.economy.backpackChestPriceMattWei];
if (Number(await chest.activeDefinitionVersion()) !== config.definitions.version || !(await chest.definitionVersionFrozen(config.definitions.version))) throw new Error("Definition version mismatch.");
for (let slot = 0; slot < 6; slot += 1) {
  if (await chest.chestPrice(slot) !== prices[slot]) throw new Error(`Chest price ${slot} mismatch.`);
  for (let rarity = 0; rarity < 5; rarity += 1) {
    const pool = await chest.definitionPool(config.definitions.version, slot, rarity);
    const expected = config.definitions.baseDefinitionId + slot * 100 + rarity;
    if (pool.length !== 1 || Number(pool[0]) !== expected) throw new Error(`Definition pool ${slot}/${rarity} mismatch.`);
  }
}
for (const [mode, map] of Object.entries(config.maps)) {
  const args = [map.mapId, map.contentHash, map.mineableCrystalUnits, map.conversionRateWei, map.maximumPayoutWei, map.runTimeoutSeconds];
  const versionId = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "uint32", "uint256", "uint256", "uint32"], args));
  if (manifest.mapVersions[mode] !== versionId) throw new Error(`${mode} map manifest mismatch.`);
  const state = await settlement.mapVersions(versionId);
  if (!state.approved || state.retired) throw new Error(`${mode} map is not approved and active.`);
}
if (getAddress(await settlement.rewardSigner()) !== config.roles.rootAdmin || !(await settlement.hasRole(await settlement.OPERATOR_ROLE(), config.roles.rootAdmin))) throw new Error("Bootstrap Settlement roles mismatch.");
console.log("Ronin Mainnet NFT V2 safe-bootstrap deployment verified on-chain.");
console.log("All fourteen contracts have code, all seven gameplay modules remain paused, both collections are empty, and every cap, proxy, map, price, role, and dependency matches.");
console.log("External VRF subscription consumers, Crystal minters, dedicated roles, source verification, and activation intentionally remain next.");
