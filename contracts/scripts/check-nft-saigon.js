import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import { loadNftSaigonConfig, validateNftSaigonNetwork } from "./lib/nft-saigon.js";

const deploymentPath = process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH)
  : resolve("deployments", "nft-saigon.json");
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const config = loadNftSaigonConfig();
const { ethers } = await network.create();
await validateNftSaigonNetwork(ethers);

const contract = async (name) => {
  const address = manifest.contracts?.[name]?.address;
  if (!address || await ethers.provider.getCode(address) === "0x") throw new Error(`${name} has no deployed code.`);
  return ethers.getContractAt(name, address);
};
const matt = await contract("MattMineSaigonMatt");
const crystal = await contract("MattMineSaigonCrystal");
const randomness = await contract("MattMineSaigonRandomness");
const miner = await contract("MattMiner");
const equipment = await contract("MattEquipment");
const loadout = await contract("MattLoadout");
const chest = await contract("MattChest");
const settlement = await contract("MattGameSettlement");
const redemption = await contract("MattCrystalRedemption");

for (const [label, instance] of Object.entries({ matt, crystal, randomness })) {
  assertAddress(await instance.owner(), config.roles.contractAdmin, `${label} owner`);
}
for (const [label, instance] of Object.entries({ miner, equipment, loadout, chest, settlement, redemption })) {
  assertAddress(await instance.defaultAdmin(), config.roles.contractAdmin, `${label} default admin`);
}
assertAddress(await randomness.oracle(), config.roles.randomnessOracle, "randomness oracle");
assertAddress(await loadout.miner(), miner.target, "loadout Miner");
assertAddress(await loadout.equipment(), equipment.target, "loadout Equipment");
assertAddress(await loadout.matt(), matt.target, "loadout MATT");
assertAddress(await chest.matt(), matt.target, "chest MATT");
assertAddress(await chest.equipment(), equipment.target, "chest Equipment");
assertAddress(await chest.randomnessProvider(), randomness.target, "chest randomness");
assertAddress(await settlement.miner(), miner.target, "settlement Miner");
assertAddress(await settlement.loadout(), loadout.target, "settlement Loadout");
assertAddress(await redemption.crystal(), crystal.target, "redemption Crystal");
assertAddress(await settlement.gameSigner(), config.roles.gameSigner, "game signer");
assertAddress(await redemption.redemptionSigner(), config.roles.redemptionSigner, "redemption signer");
if (!(await crystal.minters(redemption.target))) throw new Error("Redemption is not an authorized Crystal minter.");

await requireRole(miner, await miner.PROGRESSION_ROLE(), settlement.target, "Miner progression");
await requireRole(miner, await miner.METADATA_ROLE(), loadout.target, "Miner metadata");
await requireRole(equipment, await equipment.MINTER_ROLE(), chest.target, "Equipment mint");
await requireRole(equipment, await equipment.LOADOUT_ROLE(), loadout.target, "Equipment loadout");
await requireRole(equipment, await equipment.STATE_ROLE(), loadout.target, "Equipment state");
await requireRole(equipment, await equipment.BURNER_ROLE(), loadout.target, "Equipment burn");
await requireRole(loadout, await loadout.GAME_ROLE(), settlement.target, "Loadout game");
await requireRole(settlement, await settlement.RUN_MANAGER_ROLE(), config.roles.gameOperator, "Run manager");

const expectedPrices = [
  config.economy.weaponChestPriceMattWei,
  config.economy.helmetChestPriceMattWei,
  config.economy.commonArmorChestPriceMattWei,
  config.economy.rareArmorChestPriceMattWei,
  config.economy.mythicArmorChestPriceMattWei
];
for (let index = 0; index < expectedPrices.length; index += 1) {
  if (await chest.chestPrice(index) !== expectedPrices[index]) throw new Error(`Chest price ${index} is incorrect.`);
}
if (await loadout.repairPrice() !== config.economy.repairPriceMattWei) throw new Error("Repair price is incorrect.");
if (await chest.backpackPrice() !== config.economy.backpackPriceMattWei) throw new Error("Backpack price is incorrect.");
if (await chest.backpackDefinitionId() !== BigInt(config.economy.backpackDefinitionId)) {
  throw new Error("Backpack definition is incorrect.");
}
for (const { itemType, firstId } of [
  { itemType: 0, firstId: 101 },
  { itemType: 2, firstId: 301 },
  { itemType: 3, firstId: 401 }
]) {
  for (let rarity = 0; rarity <= 4; rarity += 1) {
    const pool = await chest.definitionPool(itemType, rarity);
    if (pool.length !== 1 || pool[0] !== BigInt(firstId + rarity)) {
      throw new Error(`Definition pool item ${itemType} rarity ${rarity} is incorrect.`);
    }
  }
}
for (const [label, instance] of Object.entries({ loadout, chest, settlement, redemption })) {
  if (!(await instance.paused())) throw new Error(`${label} is unexpectedly unpaused.`);
}

console.log("Saigon NFT configuration verified on-chain.");
console.log("All nine contracts have code, 0xF799 controls every admin/owner path, roles and prices match, and gameplay remains paused.");

function assertAddress(actual, expected, label) {
  if (getAddress(actual) !== getAddress(expected)) throw new Error(`${label} is ${actual}; expected ${expected}.`);
}

async function requireRole(instance, role, account, label) {
  if (!(await instance.hasRole(role, account))) throw new Error(`${label} role is missing for ${account}.`);
}
