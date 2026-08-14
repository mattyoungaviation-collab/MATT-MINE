import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AbiCoder, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_SAIGON_CONFIG_PATH,
  NFT_V2_SAIGON_RELEASE_ID,
  loadNftV2SaigonConfig,
  validateNftV2SaigonNetwork
} from "./lib/nft-v2-saigon.js";

const { ethers } = await network.create();
const config = loadNftV2SaigonConfig();
await validateNftV2SaigonNetwork(ethers);
const deploymentPath = process.env.MATT_MINE_NFT_V2_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_SAIGON_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_SAIGON_CONFIG_PATH), "..", "deployments", "nft-v2-saigon.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing V2 deployment manifest ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (manifest.releaseId !== NFT_V2_SAIGON_RELEASE_ID || manifest.scope !== "MattMineNftV2Saigon") {
  throw new Error("Deployment manifest is not the approved V2 Saigon release.");
}
const configHash = keccak256(toUtf8Bytes(JSON.stringify(jsonSafe(config))));
if (
  manifest.chainId !== config.chainId
  || manifest.configHash !== configHash
  || getAddress(manifest.deployer) !== config.roles.rootAdmin
  || manifest.status !== "deployed_configured_paused_requires_role_separation"
) {
  throw new Error("Deployment manifest does not match the exact approved V2 Saigon configuration.");
}

for (const [label, record] of Object.entries(manifest.contracts)) {
  if ((await ethers.provider.getCode(record.address)) === "0x") throw new Error(`${label} has no code.`);
}

const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address);
const matt = await at("MattMineSaigonMatt", "SaigonMatt");
const crystal = await at("MattMineSaigonCrystal", "SaigonCrystal");
const timelock = await at("MattV2UpgradeTimelock", "UpgradeTimelock");
const miner = await at("MattV2Miner", "Miner");
const equipment = await at("MattV2Equipment", "Equipment");
const loadout = await at("MattV2Loadout", "Loadout");
const bank = await at("MattV2CrystalBank", "CrystalBankProxy");
const passive = await at("MattV2PassiveRewards", "PassiveRewardsProxy");
const settlement = await at("MattV2GameSettlement", "GameSettlementProxy");
const chest = await at("MattV2Chest", "ChestProxy");
const chestRandomness = await at("MattMineSaigonRandomness", "ChestRandomness");
const passiveRandomness = await at("MattMineSaigonRandomness", "PassiveRandomness");

for (const [label, contract] of Object.entries({ miner, equipment, loadout, bank, passive, settlement, chest })) {
  if (!(await contract.paused())) throw new Error(`${label} is unexpectedly live.`);
  if (getAddress(await contract.defaultAdmin()) !== config.roles.rootAdmin) throw new Error(`${label} admin mismatch.`);
}
if (getAddress(await matt.owner()) !== config.roles.rootAdmin) throw new Error("Saigon MATT owner mismatch.");
if (getAddress(await crystal.owner()) !== config.roles.rootAdmin) throw new Error("Saigon Crystal owner mismatch.");
if (getAddress(await timelock.owner()) !== config.roles.rootAdmin) throw new Error("Upgrade Timelock owner mismatch.");
if (await timelock.UPGRADE_DELAY() !== 172_800n) throw new Error("Upgrade delay is not exactly 48 hours.");
if (await miner.MAX_SUPPLY() !== 1_000n || await miner.nextTokenId() !== 1n) throw new Error("Miner supply guard mismatch.");
if (await equipment.nextTokenId() !== 1n) throw new Error("Equipment was unexpectedly minted.");
if (getAddress(await chestRandomness.owner()) !== config.roles.rootAdmin) throw new Error("Chest randomness owner mismatch.");
if (getAddress(await chestRandomness.oracle()) !== config.roles.randomnessOracle) {
  throw new Error("Chest randomness oracle mismatch.");
}
if (getAddress(await passiveRandomness.owner()) !== config.roles.rootAdmin) {
  throw new Error("Passive randomness owner mismatch.");
}
if (getAddress(await passiveRandomness.oracle()) !== config.roles.randomnessOracle) {
  throw new Error("Passive randomness oracle mismatch.");
}
if (!(await chestRandomness.supportsRequestCancellation()) || !(await passiveRandomness.supportsRequestCancellation())) {
  throw new Error("Saigon randomness adapters do not expose the required request-cancellation path.");
}

const expectedAddresses = {
  miner: miner.target,
  equipment: equipment.target,
  matt: matt.target,
  crystal: crystal.target,
  loadout: loadout.target,
  bank: bank.target,
  passive: passive.target,
  settlement: settlement.target,
  chestRandomness: chestRandomness.target,
  passiveRandomness: passiveRandomness.target
};
for (const [label, actual, expected] of [
  ["Loadout Miner", await loadout.miner(), expectedAddresses.miner],
  ["Loadout Equipment", await loadout.equipment(), expectedAddresses.equipment],
  ["Loadout MATT", await loadout.matt(), expectedAddresses.matt],
  ["Bank Crystal", await bank.crystal(), expectedAddresses.crystal],
  ["Passive Miner", await passive.miner(), expectedAddresses.miner],
  ["Passive Crystal", await passive.crystal(), expectedAddresses.crystal],
  ["Passive randomness", await passive.randomnessProvider(), expectedAddresses.passiveRandomness],
  ["Settlement Miner", await settlement.miner(), expectedAddresses.miner],
  ["Settlement Loadout", await settlement.loadout(), expectedAddresses.loadout],
  ["Settlement Bank", await settlement.crystalBank(), expectedAddresses.bank],
  ["Settlement Passive", await settlement.passiveRewards(), expectedAddresses.passive],
  ["Chest MATT", await chest.matt(), expectedAddresses.matt],
  ["Chest Equipment", await chest.equipment(), expectedAddresses.equipment],
  ["Chest randomness", await chest.randomnessProvider(), expectedAddresses.chestRandomness]
]) {
  if (getAddress(actual) !== getAddress(expected)) throw new Error(`${label} wiring mismatch.`);
}
for (const [label, actual] of [
  ["Loadout Treasury", await loadout.treasury()],
  ["Chest Treasury", await chest.treasury()]
]) {
  if (getAddress(actual) !== config.roles.treasury) throw new Error(`${label} mismatch.`);
}
if (await loadout.repairPrice() !== config.economy.repairPriceMattWei) throw new Error("Repair price mismatch.");

for (const [label, collection] of [["Miner", miner], ["Equipment", equipment]]) {
  const royalty = await collection.royaltyInfo(1n, 10_000n);
  if (getAddress(royalty[0]) !== config.roles.treasury || royalty[1] !== 500n) {
    throw new Error(`${label} royalty mismatch.`);
  }
}

for (const module of [bank, passive, settlement, chest]) {
  if (getAddress(await module.UPGRADE_TIMELOCK()) !== getAddress(timelock.target)) {
    throw new Error("A UUPS module is not bound to the approved 48-hour timelock.");
  }
}
if (!(await crystal.minters(bank.target)) || !(await crystal.minters(passive.target))) {
  throw new Error("Bank and Passive Rewards must both be Crystal minters.");
}
if (!(await miner.hasRole(await miner.PROGRESSION_ROLE(), settlement.target))) throw new Error("Miner progression wiring missing.");
if (!(await miner.hasRole(await miner.LOCK_ROLE(), settlement.target))) throw new Error("Miner lock wiring missing.");
if (!(await miner.hasRole(await miner.PASSIVE_ROLE(), passive.target))) throw new Error("Miner passive wiring missing.");
if (!(await miner.hasRole(await miner.METADATA_ROLE(), loadout.target))) {
  throw new Error("Miner metadata wiring to Loadout missing.");
}
if (!(await equipment.hasRole(await equipment.MINTER_ROLE(), chest.target))) throw new Error("Chest mint wiring missing.");
if (!(await equipment.hasRole(await equipment.LOADOUT_ROLE(), loadout.target))) throw new Error("Equipment loadout wiring missing.");
if (!(await equipment.hasRole(await equipment.STATE_ROLE(), loadout.target))) throw new Error("Equipment state wiring missing.");
if (!(await equipment.hasRole(await equipment.BURNER_ROLE(), loadout.target))) throw new Error("Equipment burn wiring missing.");
if (!(await loadout.hasRole(await loadout.GAME_ROLE(), settlement.target))) throw new Error("Loadout game wiring missing.");
if (!(await bank.hasRole(await bank.CREDIT_ROLE(), settlement.target))) throw new Error("Bank credit wiring missing.");
if (!(await passive.hasRole(await passive.SETTLEMENT_ROLE(), settlement.target))) throw new Error("Passive settlement wiring missing.");
for (const [label, contract, role] of [
  ["Miner minter", miner, await miner.MINTER_ROLE()],
  ["Miner progression", miner, await miner.PROGRESSION_ROLE()],
  ["Miner lock", miner, await miner.LOCK_ROLE()],
  ["Miner passive", miner, await miner.PASSIVE_ROLE()],
  ["Miner metadata", miner, await miner.METADATA_ROLE()],
  ["Miner pauser", miner, await miner.PAUSER_ROLE()],
  ["Equipment minter", equipment, await equipment.MINTER_ROLE()],
  ["Equipment loadout", equipment, await equipment.LOADOUT_ROLE()],
  ["Equipment state", equipment, await equipment.STATE_ROLE()],
  ["Equipment burner", equipment, await equipment.BURNER_ROLE()],
  ["Equipment metadata", equipment, await equipment.METADATA_ROLE()],
  ["Equipment pauser", equipment, await equipment.PAUSER_ROLE()],
  ["Loadout game", loadout, await loadout.GAME_ROLE()],
  ["Loadout config", loadout, await loadout.CONFIG_ROLE()],
  ["Loadout pauser", loadout, await loadout.PAUSER_ROLE()],
  ["Bank credit", bank, await bank.CREDIT_ROLE()],
  ["Bank config", bank, await bank.CONFIG_ROLE()],
  ["Bank pauser", bank, await bank.PAUSER_ROLE()],
  ["Passive settlement", passive, await passive.SETTLEMENT_ROLE()],
  ["Passive keeper", passive, await passive.KEEPER_ROLE()],
  ["Passive pauser", passive, await passive.PAUSER_ROLE()],
  ["Settlement operator", settlement, await settlement.OPERATOR_ROLE()],
  ["Settlement config", settlement, await settlement.CONFIG_ROLE()],
  ["Settlement pauser", settlement, await settlement.PAUSER_ROLE()],
  ["Chest config", chest, await chest.CONFIG_ROLE()],
  ["Chest pauser", chest, await chest.PAUSER_ROLE()]
]) {
  if (!(await contract.hasRole(role, config.roles.rootAdmin))) throw new Error(`${label} bootstrap role mismatch.`);
}

if (await bank.minimumWithdrawal() !== 100n * 10n ** 18n) throw new Error("Withdrawal minimum mismatch.");
if (await bank.walletDailyLimit() !== 100_000n * 10n ** 18n) throw new Error("Wallet launch limit mismatch.");
if (await bank.globalDailyLimit() !== 10_000_000n * 10n ** 18n) throw new Error("Global launch limit mismatch.");
if (Number(await chest.activeDefinitionVersion()) !== config.definitions.version) throw new Error("Definition version mismatch.");
if (!(await chest.definitionVersionFrozen(config.definitions.version))) throw new Error("Definition version is not frozen.");

const chestPrices = [
  config.economy.armorChestPriceMattWei,
  config.economy.pickaxeChestPriceMattWei,
  config.economy.blasterChestPriceMattWei,
  config.economy.dynamiteChestPriceMattWei,
  config.economy.helmetChestPriceMattWei,
  config.economy.backpackChestPriceMattWei
];
for (let slot = 0; slot < 6; slot += 1) {
  if (await chest.chestPrice(slot) !== chestPrices[slot]) throw new Error(`Chest price slot ${slot} mismatch.`);
  for (let rarity = 0; rarity < 5; rarity += 1) {
    const expectedDefinition = config.definitions.baseDefinitionId + slot * 100 + rarity;
    const pool = await chest.definitionPool(config.definitions.version, slot, rarity);
    if (pool.length !== 1 || Number(pool[0]) !== expectedDefinition) {
      throw new Error(`Definition pool slot ${slot} rarity ${rarity} mismatch.`);
    }
  }
}

const mapArguments = [
  config.launchMap.mapId,
  config.launchMap.contentHash,
  config.launchMap.mineableCrystalUnits,
  config.launchMap.conversionRateWei,
  config.launchMap.maximumPayoutWei,
  config.launchMap.runTimeoutSeconds
];
const mapVersion = keccak256(AbiCoder.defaultAbiCoder().encode(
  ["bytes32", "bytes32", "uint32", "uint256", "uint256", "uint32"],
  mapArguments
));
const mapState = await settlement.mapVersions(mapVersion);
if (
  !mapState.approved || mapState.retired
  || mapState.mapId !== config.launchMap.mapId
  || mapState.contentHash !== config.launchMap.contentHash
  || mapState.mineableCrystalUnits !== BigInt(config.launchMap.mineableCrystalUnits)
  || mapState.conversionRate !== config.launchMap.conversionRateWei
  || mapState.maximumPayout !== config.launchMap.maximumPayoutWei
  || mapState.runTimeout !== BigInt(config.launchMap.runTimeoutSeconds)
) throw new Error("Launch map does not exactly match the approved active version.");

if (getAddress(await settlement.rewardSigner()) !== config.roles.rootAdmin) {
  throw new Error("Bootstrap Reward Signer differs from the approved initial root.");
}
if (!(await settlement.hasRole(await settlement.OPERATOR_ROLE(), config.roles.rootAdmin))) {
  throw new Error("Bootstrap root is missing the initial Game Operator role.");
}

console.log("V2 Saigon deployment verified on-chain in its safe bootstrap state.");
console.log("All contracts have code, remain paused, contain zero NFTs, and match the approved caps and wiring.");
console.log("Reward Signer and Game Operator still intentionally overlap at bootstrap, so Settlement cannot be unpaused.");

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
