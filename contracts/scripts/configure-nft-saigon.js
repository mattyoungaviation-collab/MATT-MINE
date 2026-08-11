import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import { loadNftSaigonConfig, validateNftSaigonNetwork } from "./lib/nft-saigon.js";

const CONFIRMATION = "CONFIGURE_MATT_MINE_NFT_V1_ON_SAIGON";
if (process.env.MATT_MINE_NFT_SAIGON_SETUP_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_NFT_SAIGON_SETUP_CONFIRMATION=${CONFIRMATION} after reviewing the deployed addresses.`);
}

const deploymentPath = process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH)
  : resolve("deployments", "nft-saigon.json");
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const config = loadNftSaigonConfig();
const { ethers } = await network.create();
await validateNftSaigonNetwork(ethers);

if (manifest.chainId !== config.chainId || manifest.scope !== "MattMineNftV1Saigon") {
  throw new Error("The Saigon deployment manifest has the wrong chain or scope.");
}
const signers = await ethers.getSigners();
if (signers.length !== 1) throw new Error("Configure exactly one encrypted Saigon admin signer.");
const [admin] = signers;
const adminAddress = getAddress(await admin.getAddress());
if (adminAddress !== config.roles.contractAdmin) {
  throw new Error(`Encrypted NUGG signer resolves to ${adminAddress}, not ${config.roles.contractAdmin}.`);
}

const contract = async (name) => {
  const record = manifest.contracts?.[name];
  if (!record?.address || await ethers.provider.getCode(record.address) === "0x") {
    throw new Error(`${name} is missing from the deployed Saigon manifest.`);
  }
  return ethers.getContractAt(name, record.address, admin);
};

const crystal = await contract("MattMineSaigonCrystal");
const miner = await contract("MattMiner");
const equipment = await contract("MattEquipment");
const loadout = await contract("MattLoadout");
const chest = await contract("MattChest");
const settlement = await contract("MattGameSettlement");
const redemption = await contract("MattCrystalRedemption");
const transactions = [];

await sendIf(
  !(await crystal.minters(redemption.target)),
  "Authorize Crystal redemption minter",
  () => crystal.setMinter(redemption.target, true)
);
await grantIfMissing(miner, await miner.PROGRESSION_ROLE(), settlement.target, "Miner progression -> Settlement");
await grantIfMissing(miner, await miner.METADATA_ROLE(), loadout.target, "Miner metadata -> Loadout");
await grantIfMissing(equipment, await equipment.MINTER_ROLE(), chest.target, "Equipment mint -> Chest");
await grantIfMissing(equipment, await equipment.LOADOUT_ROLE(), loadout.target, "Equipment loadout -> Loadout");
await grantIfMissing(equipment, await equipment.STATE_ROLE(), loadout.target, "Equipment state -> Loadout");
await grantIfMissing(equipment, await equipment.BURNER_ROLE(), loadout.target, "Equipment burn -> Loadout");
await grantIfMissing(loadout, await loadout.GAME_ROLE(), settlement.target, "Loadout game -> Settlement");

const chestPrices = [
  config.economy.weaponChestPriceMattWei,
  config.economy.helmetChestPriceMattWei,
  config.economy.commonArmorChestPriceMattWei,
  config.economy.rareArmorChestPriceMattWei,
  config.economy.mythicArmorChestPriceMattWei
];
for (let chestType = 0; chestType < chestPrices.length; chestType += 1) {
  const expected = chestPrices[chestType];
  await sendIf(
    await chest.chestPrice(chestType) !== expected,
    `Set chest price ${chestType}`,
    () => chest.setChestPrice(chestType, expected)
  );
}
await sendIf(
  await chest.backpackPrice() !== config.economy.backpackPriceMattWei
    || await chest.backpackDefinitionId() !== BigInt(config.economy.backpackDefinitionId),
  "Set backpack price and definition",
  () => chest.setBackpackConfiguration(
    config.economy.backpackPriceMattWei,
    config.economy.backpackDefinitionId
  )
);

const definitionSets = [
  { itemType: 0, firstId: 101 },
  { itemType: 2, firstId: 301 },
  { itemType: 3, firstId: 401 }
];
for (const { itemType, firstId } of definitionSets) {
  for (let rarity = 0; rarity <= 4; rarity += 1) {
    const expectedId = BigInt(firstId + rarity);
    const current = await chest.definitionPool(itemType, rarity);
    await sendIf(
      current.length !== 1 || current[0] !== expectedId,
      `Set definition pool item ${itemType} rarity ${rarity}`,
      () => chest.setDefinitionPool(itemType, rarity, [expectedId])
    );
  }
}

for (const [label, instance] of Object.entries({ loadout, chest, settlement, redemption })) {
  if (!(await instance.paused())) throw new Error(`${label} must remain paused during setup.`);
}

manifest.status = "configured_paused_ready_for_rehearsal";
manifest.configuredAt = new Date().toISOString();
manifest.configurationTransactions = transactions;
manifest.requiredPostDeploymentActions = [
  "Run the read-only Saigon configuration checker",
  "Verify contract source on the Saigon explorer",
  "Choose a test-player wallet and distribute test MATT",
  "Mint one controlled test Miner",
  "Unpause only for the end-to-end rehearsal"
];
const temporaryPath = `${deploymentPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
renameSync(temporaryPath, deploymentPath);

console.log(`Saigon NFT suite configured in ${transactions.length} transaction(s) and remains paused.`);
console.log(`Manifest: ${deploymentPath}`);

async function grantIfMissing(instance, role, account, label) {
  await sendIf(!(await instance.hasRole(role, account)), label, () => instance.grantRole(role, account));
}

async function sendIf(condition, label, operation) {
  if (!condition) {
    console.log(`Already configured: ${label}`);
    return;
  }
  const transaction = await operation();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} transaction failed.`);
  transactions.push({ label, transactionHash: transaction.hash, blockNumber: receipt.blockNumber });
  console.log(`${label}: ${transaction.hash}`);
}
