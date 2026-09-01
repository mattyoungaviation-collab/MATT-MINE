import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, id } from "ethers";
import { network } from "hardhat";
import { NFT_V2_MAINNET_CHAIN_ID, NFT_V2_ROOT } from "./lib/nft-v2-mainnet.js";

const CONFIRMATION = "EXECUTE_CHEST_BATCH_UPGRADE";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SALT = id("MATT_MINE_CHEST_BATCH_PURCHASE_V1");
const MAX_CHESTS_PER_PURCHASE = 10n;
if (process.env.MATT_MINE_CHEST_BATCH_UPGRADE_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_CHEST_BATCH_UPGRADE_CONFIRMATION=${CONFIRMATION}.`);
}

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== NFT_V2_MAINNET_CHAIN_ID) {
  throw new Error("Wrong network; expected Ronin Mainnet 2020.");
}
const [signer, ...extra] = await ethers.getSigners();
if (!signer || extra.length) throw new Error("Configure exactly one encrypted NUGG deployment signer.");
if (getAddress(await signer.getAddress()) !== NFT_V2_ROOT) throw new Error(`Signer must be ${NFT_V2_ROOT}.`);

const deploymentPath = resolve("deployments", "nft-v2-ronin.json");
const upgradePath = resolve("deployments", "nft-v2-chest-batch-upgrade.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
if (!existsSync(upgradePath)) throw new Error("Run the Chest batch upgrade scheduling script first.");
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const upgrade = JSON.parse(readFileSync(upgradePath, "utf8"));
const expected = {
  timelock: getAddress(deployment.contracts?.UpgradeTimelock?.address),
  proxy: getAddress(deployment.contracts?.ChestProxy?.address),
  previousImplementation: getAddress(deployment.contracts?.ChestImplementation?.address)
};
validateCheckpoint(upgrade, expected);

const timelock = await ethers.getContractAt("MattV2UpgradeTimelock", expected.timelock, signer);
if (getAddress(await timelock.owner()) !== NFT_V2_ROOT) {
  throw new Error("0xF799 is not the Upgrade Timelock owner.");
}
if ((await ethers.provider.getCode(upgrade.implementation)) === "0x") {
  throw new Error("Saved implementation has no code.");
}
const implementation = await ethers.getContractAt("MattV2Chest", upgrade.implementation);
if (getAddress(await implementation.UPGRADE_TIMELOCK()) !== expected.timelock) {
  throw new Error("Implementation timelock mismatch.");
}
if ((await implementation.proxiableUUID()).toLowerCase() !== IMPLEMENTATION_SLOT.toLowerCase()) {
  throw new Error("Implementation does not expose the expected ERC-1967 upgrade slot.");
}
if (await implementation.MAX_CHESTS_PER_PURCHASE() !== MAX_CHESTS_PER_PURCHASE) {
  throw new Error("Implementation does not expose the required ten-chest batch limit.");
}

const current = await currentImplementation(expected.proxy);
if (current === getAddress(upgrade.implementation)) {
  const chest = await ethers.getContractAt("MattV2Chest", expected.proxy);
  if (await chest.MAX_CHESTS_PER_PURCHASE() !== MAX_CHESTS_PER_PURCHASE) {
    throw new Error("Chest proxy is upgraded but its batch getter is invalid.");
  }
  upgrade.status = "executed";
  save(upgradePath, upgrade);
  console.log("Chest batch upgrade was already executed and verified.");
  process.exit(0);
}
if (current !== expected.previousImplementation) {
  throw new Error(`Unexpected current Chest implementation ${current}.`);
}

const operationId = await timelock.operationId(expected.proxy, upgrade.implementation, upgrade.data, upgrade.salt);
if (!upgrade.operationId || upgrade.operationId.toLowerCase() !== operationId.toLowerCase()) {
  throw new Error("Saved operation ID does not match the on-chain upgrade parameters.");
}
const readyAt = await timelock.readyAt(operationId);
if (readyAt === 0n) throw new Error("The saved Chest batch upgrade is not scheduled on-chain.");
const latestBlock = await ethers.provider.getBlock("latest");
if (BigInt(latestBlock.timestamp) < readyAt) {
  throw new Error(`Upgrade is not ready. Try again after ${new Date(Number(readyAt) * 1000).toISOString()}.`);
}

const chest = await ethers.getContractAt("MattV2Chest", expected.proxy);
const stateBefore = await readChestState(chest);
const transaction = await timelock.execute(expected.proxy, upgrade.implementation, upgrade.data, upgrade.salt);
upgrade.executeTransactionHash = transaction.hash;
upgrade.status = "execution_broadcast";
save(upgradePath, upgrade);
const receipt = await transaction.wait();
if (receipt.status !== 1) throw new Error("Chest batch upgrade execution failed.");
upgrade.executeBlock = receipt.blockNumber;
upgrade.status = "execution_mined";
save(upgradePath, upgrade);

if (await currentImplementation(expected.proxy) !== getAddress(upgrade.implementation)) {
  throw new Error("Chest proxy implementation did not change.");
}
if (await chest.MAX_CHESTS_PER_PURCHASE() !== MAX_CHESTS_PER_PURCHASE) {
  throw new Error("Chest proxy does not expose the ten-chest batch limit after upgrade.");
}
const stateAfter = await readChestState(chest);
if (JSON.stringify(stateAfter) !== JSON.stringify(stateBefore)) {
  throw new Error("Chest state changed unexpectedly during the implementation upgrade.");
}

upgrade.preservedState = stateAfter;
upgrade.executedAt = new Date().toISOString();
upgrade.status = "executed";
save(upgradePath, upgrade);
console.log(`Chest batch purchasing enabled: ${transaction.hash}`);
console.log("Players can now purchase up to ten same-slot chests in one transaction.");

async function readChestState(chestContract) {
  const mattAddress = getAddress(await chestContract.matt());
  return {
    matt: mattAddress,
    equipment: getAddress(await chestContract.equipment()),
    randomnessProvider: getAddress(await chestContract.randomnessProvider()),
    treasury: getAddress(await chestContract.treasury()),
    activeDefinitionVersion: String(await chestContract.activeDefinitionVersion()),
    defaultAdmin: getAddress(await chestContract.defaultAdmin()),
    defaultAdminDelay: String(await chestContract.defaultAdminDelay()),
    paused: await chestContract.paused(),
    chestPrices: await Promise.all(
      Array.from({ length: 6 }, async (_, slot) => String(await chestContract.chestPrice(slot)))
    )
  };
}

async function currentImplementation(proxy) {
  const value = await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT);
  return getAddress(`0x${value.slice(-40)}`);
}

function validateCheckpoint(value, expected) {
  if (getAddress(value.proxy) !== expected.proxy) throw new Error("Saved Chest proxy mismatch.");
  if (getAddress(value.previousImplementation) !== expected.previousImplementation) {
    throw new Error("Saved previous Chest implementation mismatch.");
  }
  if (getAddress(value.timelock) !== expected.timelock) throw new Error("Saved timelock mismatch.");
  if (value.salt?.toLowerCase() !== SALT.toLowerCase() || value.data !== "0x") {
    throw new Error("Saved Chest upgrade parameters are not the expected batch upgrade.");
  }
}

function save(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
