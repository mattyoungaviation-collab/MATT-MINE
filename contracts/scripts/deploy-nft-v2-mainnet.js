import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AbiCoder, formatEther, getAddress, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CHAIN_ID,
  NFT_V2_MAINNET_CONFIG_PATH,
  NFT_V2_MAINNET_CONFIRMATION,
  NFT_V2_MAINNET_RELEASE_ID,
  NFT_V2_ROOT,
  jsonSafe,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";
import { buildNftV2DeploymentPlan } from "./lib/nft-v2-deployment-plan.js";

if (process.env.MATT_MINE_NFT_V2_MAINNET_CONFIRMATION !== NFT_V2_MAINNET_CONFIRMATION) {
  throw new Error(`Set MATT_MINE_NFT_V2_MAINNET_CONFIRMATION=${NFT_V2_MAINNET_CONFIRMATION} after the read-only preflight passes.`);
}
const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const [deployer, ...extra] = await ethers.getSigners();
if (!deployer || extra.length) throw new Error("Configure exactly one encrypted V2 deployment signer.");
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== NFT_V2_ROOT) throw new Error(`NUGG deployer is ${deployerAddress}; expected ${NFT_V2_ROOT}.`);

const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
const configHash = keccak256(toUtf8Bytes(JSON.stringify(jsonSafe(config))));
let manifest = existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, "utf8")) : null;
if (!manifest) {
  const latest = await ethers.provider.getTransactionCount(deployerAddress, "latest");
  const pending = await ethers.provider.getTransactionCount(deployerAddress, "pending");
  if (latest !== pending) throw new Error("The deployment wallet has pending transactions.");
  manifest = {
    schemaVersion: 2,
    scope: "MattMineNftV2Ronin",
    releaseId: NFT_V2_MAINNET_RELEASE_ID,
    chainId: Number(NFT_V2_MAINNET_CHAIN_ID),
    configHash,
    deployer: deployerAddress,
    startingNonce: pending,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {},
    setupTransactions: [],
    mapVersions: {}
  };
  save();
} else if (
  manifest.scope !== "MattMineNftV2Ronin" || manifest.releaseId !== NFT_V2_MAINNET_RELEASE_ID
  || manifest.configHash !== configHash || getAddress(manifest.deployer) !== deployerAddress
) {
  throw new Error("Existing V2 mainnet manifest belongs to another release, config, or deployer.");
}

const plan = await buildNftV2DeploymentPlan(ethers, config, deployerAddress, manifest.startingNonce);
for (const step of plan.steps) await deployOrRecover(step);

const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address, deployer);
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

await sendIf((await chestRandomness.consumer()) === ethers.ZeroAddress, "Chest VRF consumer", () => chestRandomness.setConsumer(chest.target));
await sendIf((await passiveRandomness.consumer()) === ethers.ZeroAddress, "Passive VRF consumer", () => passiveRandomness.setConsumer(passive.target));
await grant(miner, await miner.PROGRESSION_ROLE(), settlement.target, "Miner progression -> Settlement");
await grant(miner, await miner.LOCK_ROLE(), settlement.target, "Miner lock -> Settlement");
await grant(miner, await miner.PASSIVE_ROLE(), passive.target, "Miner passive -> Passive Rewards");
await grant(miner, await miner.METADATA_ROLE(), loadout.target, "Miner metadata -> Loadout");
await grant(equipment, await equipment.MINTER_ROLE(), chest.target, "Equipment mint -> Chest");
await grant(equipment, await equipment.LOADOUT_ROLE(), loadout.target, "Equipment loadout -> Loadout");
await grant(equipment, await equipment.STATE_ROLE(), loadout.target, "Equipment state -> Loadout");
await grant(equipment, await equipment.BURNER_ROLE(), loadout.target, "Equipment burn -> Loadout");
await grant(loadout, await loadout.GAME_ROLE(), settlement.target, "Loadout game -> Settlement");
await grant(bank, await bank.CREDIT_ROLE(), settlement.target, "Crystal Bank credit -> Settlement");
await grant(passive, await passive.SETTLEMENT_ROLE(), settlement.target, "Passive activity -> Settlement");

const prices = [
  config.economy.armorChestPriceMattWei, config.economy.pickaxeChestPriceMattWei,
  config.economy.blasterChestPriceMattWei, config.economy.dynamiteChestPriceMattWei,
  config.economy.helmetChestPriceMattWei, config.economy.backpackChestPriceMattWei
];
for (let slot = 0; slot < 6; slot += 1) {
  await sendIf(await chest.chestPrice(slot) !== prices[slot], `Chest price slot ${slot}`, () => chest.setChestPrice(slot, prices[slot]));
  for (let rarity = 0; rarity < 5; rarity += 1) {
    const definitionId = config.definitions.baseDefinitionId + slot * 100 + rarity;
    const pool = await chest.definitionPool(config.definitions.version, slot, rarity);
    if (!pool.length) {
      await send(`Definition pool ${slot}/${rarity}`, () => chest.configureDefinitionPool(config.definitions.version, slot, rarity, [definitionId]));
    } else if (pool.length !== 1 || Number(pool[0]) !== definitionId) {
      throw new Error(`Definition pool ${slot}/${rarity} differs from the approved config.`);
    }
  }
}
await sendIf(Number(await chest.activeDefinitionVersion()) !== config.definitions.version, "Activate definition version", () => chest.activateDefinitionVersion(config.definitions.version));

for (const [mode, map] of Object.entries(config.maps)) {
  const args = [map.mapId, map.contentHash, map.mineableCrystalUnits, map.conversionRateWei, map.maximumPayoutWei, map.runTimeoutSeconds];
  const versionId = keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "uint32", "uint256", "uint256", "uint32"], args));
  manifest.mapVersions[mode] = versionId;
  const state = await settlement.mapVersions(versionId);
  await sendIf(!state.approved, `Approve ${mode} map version`, () => settlement.approveMapVersion(...args));
}

for (const [label, contract] of Object.entries({ miner, equipment, loadout, bank, passive, settlement, chest })) {
  if (!(await contract.paused())) throw new Error(`${label} must remain paused.`);
  if (getAddress(await contract.defaultAdmin()) !== config.roles.rootAdmin) throw new Error(`${label} admin mismatch.`);
}
if (getAddress(await timelock.owner()) !== config.roles.rootAdmin) throw new Error("Upgrade Timelock owner mismatch.");
if (await miner.nextTokenId() !== 1n || await equipment.nextTokenId() !== 1n) throw new Error("Fresh deployment unexpectedly contains NFTs.");

manifest.status = "deployed_configured_paused_requires_external_activation";
manifest.updatedAt = new Date().toISOString();
manifest.requiredExternalActions = [
  `VRF subscription owner: add ${chestRandomness.target} and ${passiveRandomness.target} as consumers`,
  `Crystal token owner: authorize ${bank.target} and ${passive.target} as minters`,
  "Assign the dedicated activation roles from config and revoke routine roles from 0xF799",
  "Verify source and proxy implementations, then unpause only after the final read-only check"
];
save();
console.log(`MATT Mine NFT V2 deployed, configured, empty, and PAUSED. Manifest: ${deploymentPath}`);
for (const [label, record] of Object.entries(manifest.contracts)) console.log(`${label}: ${record.address}`);
for (const [mode, version] of Object.entries(manifest.mapVersions)) console.log(`${mode} map version: ${version}`);
console.log("No NFT was minted and no gameplay path was unpaused.");

async function deployOrRecover(step) {
  const expectedAddress = getAddress(step.address);
  let record = manifest.contracts[step.label];
  if (record) {
    if (record.artifactName !== step.artifactName || getAddress(record.address) !== expectedAddress || JSON.stringify(record.constructorArgs) !== JSON.stringify(jsonSafe(step.args))) {
      throw new Error(`${step.label} checkpoint differs from the deterministic deployment plan.`);
    }
    if ((await ethers.provider.getCode(expectedAddress)) !== "0x") return;
    const receipt = await ethers.provider.getTransactionReceipt(record.transactionHash);
    if (!receipt) throw new Error(`${step.label} deployment is pending. Rerun after it confirms.`);
    if (receipt.status !== 1) throw new Error(`${step.label} deployment reverted.`);
    if ((await ethers.provider.getCode(expectedAddress)) === "0x") throw new Error(`${step.label} has no code after confirmation.`);
    record.status = "deployed";
    record.blockNumber = receipt.blockNumber;
    save();
    return;
  }
  const pendingNonce = await ethers.provider.getTransactionCount(deployerAddress, "pending");
  if (pendingNonce !== step.nonce) {
    throw new Error(`${step.label} requires deployer nonce ${step.nonce}, but the pending nonce is ${pendingNonce}. No transaction was broadcast.`);
  }
  const factory = await ethers.getContractFactory(step.artifactName, deployer);
  const contract = await factory.deploy(...step.args);
  if (getAddress(contract.target) !== expectedAddress) throw new Error(`${step.label} address drifted from its deterministic plan.`);
  const transaction = contract.deploymentTransaction();
  record = {
    artifactName: step.artifactName,
    constructorArgs: jsonSafe(step.args),
    address: expectedAddress,
    transactionHash: transaction.hash,
    status: "broadcast",
    broadcastAt: new Date().toISOString()
  };
  manifest.contracts[step.label] = record;
  save();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${step.label} deployment failed.`);
  record.status = "deployed";
  record.blockNumber = receipt.blockNumber;
  record.deployedAt = new Date().toISOString();
  save();
  console.log(`${step.label}: ${expectedAddress}`);
}

async function grant(contract, role, account, label) {
  await sendIf(!(await contract.hasRole(role, account)), label, () => contract.grantRole(role, account));
}
async function sendIf(condition, label, factory) { if (condition) await send(label, factory); }
async function send(label, factory) {
  const transaction = await factory();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed.`);
  manifest.setupTransactions.push({ label, hash: transaction.hash, blockNumber: receipt.blockNumber });
  save();
  console.log(`${label}: ${transaction.hash}`);
}
function save() {
  mkdirSync(dirname(deploymentPath), { recursive: true });
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
