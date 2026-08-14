import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { AbiCoder, formatEther, getAddress, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_ROOT,
  NFT_V2_SAIGON_CHAIN_ID,
  NFT_V2_SAIGON_CONFIG_PATH,
  NFT_V2_SAIGON_CONFIRMATION,
  NFT_V2_SAIGON_RELEASE_ID,
  loadNftV2SaigonConfig,
  validateNftV2SaigonNetwork
} from "./lib/nft-v2-saigon.js";

if (process.env.MATT_MINE_NFT_V2_SAIGON_CONFIRMATION !== NFT_V2_SAIGON_CONFIRMATION) {
  throw new Error(
    `Set MATT_MINE_NFT_V2_SAIGON_CONFIRMATION=${NFT_V2_SAIGON_CONFIRMATION} after reviewing the V2 Saigon config.`
  );
}

const { ethers } = await network.create();
const config = loadNftV2SaigonConfig();
await validateNftV2SaigonNetwork(ethers);

const [deployer, ...unexpectedSigners] = await ethers.getSigners();
if (!deployer || unexpectedSigners.length !== 0) {
  throw new Error("Configure exactly one encrypted Saigon deployment signer.");
}
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== NFT_V2_ROOT) {
  throw new Error(`Encrypted signer resolves to ${deployerAddress}; expected approved root ${NFT_V2_ROOT}.`);
}
if ((await ethers.provider.getCode(deployerAddress)) !== "0x") throw new Error("V2 deployer must be an EOA.");
const deployerBalance = await ethers.provider.getBalance(deployerAddress);
if (deployerBalance < parseEther("1")) {
  throw new Error(`Fund ${deployerAddress} with at least 1 test RON; current balance is ${formatEther(deployerBalance)}.`);
}

const deploymentPath = process.env.MATT_MINE_NFT_V2_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_SAIGON_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_SAIGON_CONFIG_PATH), "..", "deployments", "nft-v2-saigon.json");
const configHash = keccak256(toUtf8Bytes(JSON.stringify(jsonSafe(config))));
let manifest = loadManifest();
if (!manifest) {
  manifest = {
    schemaVersion: 1,
    scope: "MattMineNftV2Saigon",
    releaseId: NFT_V2_SAIGON_RELEASE_ID,
    chainId: Number(NFT_V2_SAIGON_CHAIN_ID),
    configHash,
    deployer: deployerAddress,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {},
    setupTransactions: []
  };
  saveManifest();
} else if (
  manifest.scope !== "MattMineNftV2Saigon"
  || manifest.releaseId !== NFT_V2_SAIGON_RELEASE_ID
  || manifest.configHash !== configHash
  || getAddress(manifest.deployer) !== deployerAddress
) {
  throw new Error("Existing V2 Saigon deployment manifest does not match this release, config, or deployer.");
}

console.log(`V2 Saigon deployer: ${deployerAddress} (${formatEther(deployerBalance)} RON)`);

const matt = await deployOrRecover("SaigonMatt", "MattMineSaigonMatt", [
  config.roles.rootAdmin,
  config.testTokens.initialMattSupplyWei
]);
const crystal = await deployOrRecover("SaigonCrystal", "MattMineSaigonCrystal", [config.roles.rootAdmin]);
const chestRandomness = await deployOrRecover("ChestRandomness", "MattMineSaigonRandomness", [
  config.roles.rootAdmin,
  config.roles.randomnessOracle
]);
const passiveRandomness = await deployOrRecover("PassiveRandomness", "MattMineSaigonRandomness", [
  config.roles.rootAdmin,
  config.roles.randomnessOracle
]);
const timelock = await deployOrRecover("UpgradeTimelock", "MattV2UpgradeTimelock", [config.roles.rootAdmin]);
const miner = await deployOrRecover("Miner", "MattV2Miner", [
  config.roles.rootAdmin,
  config.roles.treasury,
  config.metadata.minerBaseUri,
  config.metadata.minerContractUri
]);
const equipment = await deployOrRecover("Equipment", "MattV2Equipment", [
  config.roles.rootAdmin,
  config.roles.treasury,
  config.metadata.equipmentBaseUri,
  config.metadata.equipmentContractUri
]);
const loadout = await deployOrRecover("Loadout", "MattV2Loadout", [
  config.roles.rootAdmin,
  miner.target,
  equipment.target,
  matt.target,
  config.roles.treasury,
  config.economy.repairPriceMattWei
]);

const bankImplementation = await deployOrRecover("CrystalBankImplementation", "MattV2CrystalBank", [timelock.target]);
const bankInitialization = bankImplementation.interface.encodeFunctionData("initialize", [
  config.roles.rootAdmin,
  config.roles.emergencyPauser,
  config.roles.rootAdmin,
  config.roles.rootAdmin,
  crystal.target
]);
const bankProxy = await deployOrRecover("CrystalBankProxy", "MattV2ERC1967Proxy", [
  bankImplementation.target,
  bankInitialization
]);
const bank = await ethers.getContractAt("MattV2CrystalBank", bankProxy.target, deployer);

const passiveImplementation = await deployOrRecover("PassiveRewardsImplementation", "MattV2PassiveRewards", [
  timelock.target
]);
const passiveInitialization = passiveImplementation.interface.encodeFunctionData("initialize", [
  config.roles.rootAdmin,
  config.roles.emergencyPauser,
  config.roles.rootAdmin,
  config.roles.keeper,
  miner.target,
  crystal.target,
  passiveRandomness.target
]);
const passiveProxy = await deployOrRecover("PassiveRewardsProxy", "MattV2ERC1967Proxy", [
  passiveImplementation.target,
  passiveInitialization
]);
const passive = await ethers.getContractAt("MattV2PassiveRewards", passiveProxy.target, deployer);

const settlementImplementation = await deployOrRecover("GameSettlementImplementation", "MattV2GameSettlement", [
  timelock.target
]);
const settlementInitialization = settlementImplementation.interface.encodeFunctionData("initialize", [
  config.roles.rootAdmin,
  config.roles.emergencyPauser,
  config.roles.gameOperator,
  config.roles.rootAdmin,
  config.roles.rewardSigner,
  miner.target,
  loadout.target,
  bank.target,
  passive.target
]);
const settlementProxy = await deployOrRecover("GameSettlementProxy", "MattV2ERC1967Proxy", [
  settlementImplementation.target,
  settlementInitialization
]);
const settlement = await ethers.getContractAt("MattV2GameSettlement", settlementProxy.target, deployer);

const chestImplementation = await deployOrRecover("ChestImplementation", "MattV2Chest", [timelock.target]);
const chestInitialization = chestImplementation.interface.encodeFunctionData("initialize", [
  config.roles.rootAdmin,
  config.roles.emergencyPauser,
  config.roles.rootAdmin,
  matt.target,
  equipment.target,
  chestRandomness.target,
  config.roles.treasury
]);
const chestProxy = await deployOrRecover("ChestProxy", "MattV2ERC1967Proxy", [
  chestImplementation.target,
  chestInitialization
]);
const chest = await ethers.getContractAt("MattV2Chest", chestProxy.target, deployer);

await grantIfMissing(miner, await miner.PROGRESSION_ROLE(), settlement.target, "Miner progression -> Settlement");
await grantIfMissing(miner, await miner.LOCK_ROLE(), settlement.target, "Miner lock -> Settlement");
await grantIfMissing(miner, await miner.PASSIVE_ROLE(), passive.target, "Miner passive state -> Passive Rewards");
await grantIfMissing(miner, await miner.METADATA_ROLE(), loadout.target, "Miner metadata -> Loadout");
await grantIfMissing(equipment, await equipment.MINTER_ROLE(), chest.target, "Equipment mint -> Chest");
await grantIfMissing(equipment, await equipment.LOADOUT_ROLE(), loadout.target, "Equipment loadout -> Loadout");
await grantIfMissing(equipment, await equipment.STATE_ROLE(), loadout.target, "Equipment state -> Loadout");
await grantIfMissing(equipment, await equipment.BURNER_ROLE(), loadout.target, "Equipment burn -> Loadout");
await grantIfMissing(loadout, await loadout.GAME_ROLE(), settlement.target, "Loadout game -> Settlement");
await grantIfMissing(bank, await bank.CREDIT_ROLE(), settlement.target, "Crystal Bank credit -> Settlement");
await grantIfMissing(passive, await passive.SETTLEMENT_ROLE(), settlement.target, "Passive activity -> Settlement");

await sendIf(
  !(await crystal.minters(bank.target)),
  "Crystal minter -> Bank",
  () => crystal.setMinter(bank.target, true)
);
await sendIf(
  !(await crystal.minters(passive.target)),
  "Crystal minter -> Passive Rewards",
  () => crystal.setMinter(passive.target, true)
);

const chestPrices = [
  config.economy.armorChestPriceMattWei,
  config.economy.pickaxeChestPriceMattWei,
  config.economy.blasterChestPriceMattWei,
  config.economy.dynamiteChestPriceMattWei,
  config.economy.helmetChestPriceMattWei,
  config.economy.backpackChestPriceMattWei
];
for (let slot = 0; slot < 6; slot += 1) {
  await sendIf(
    await chest.chestPrice(slot) !== chestPrices[slot],
    `Chest price slot ${slot}`,
    () => chest.setChestPrice(slot, chestPrices[slot])
  );
  for (let rarity = 0; rarity < 5; rarity += 1) {
    const expectedDefinition = config.definitions.baseDefinitionId + slot * 100 + rarity;
    const currentPool = await chest.definitionPool(config.definitions.version, slot, rarity);
    if (currentPool.length === 0) {
      await send(
        `Definition pool v${config.definitions.version} slot ${slot} rarity ${rarity}`,
        () => chest.configureDefinitionPool(config.definitions.version, slot, rarity, [expectedDefinition])
      );
    } else if (currentPool.length !== 1 || Number(currentPool[0]) !== expectedDefinition) {
      throw new Error(`Existing definition pool slot ${slot} rarity ${rarity} differs from config.`);
    }
  }
}
await sendIf(
  Number(await chest.activeDefinitionVersion()) !== config.definitions.version,
  `Activate definition version ${config.definitions.version}`,
  () => chest.activateDefinitionVersion(config.definitions.version)
);

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
await sendIf(!mapState.approved, "Approve launch map version", () => settlement.approveMapVersion(...mapArguments));

for (const [label, contract] of Object.entries({ miner, equipment, loadout, bank, passive, settlement, chest })) {
  if (!(await contract.paused())) throw new Error(`${label} must remain paused after deployment.`);
  if (getAddress(await contract.defaultAdmin()) !== config.roles.rootAdmin) {
    throw new Error(`${label} default admin is not the approved root.`);
  }
}
if (getAddress(await timelock.owner()) !== config.roles.rootAdmin) throw new Error("Upgrade Timelock owner mismatch.");
if (await miner.nextTokenId() !== 1n || await equipment.nextTokenId() !== 1n) {
  throw new Error("Fresh V2 deployment unexpectedly contains minted NFTs.");
}

manifest.status = "deployed_configured_paused_requires_role_separation";
manifest.updatedAt = new Date().toISOString();
manifest.launchMapVersion = mapVersion;
manifest.requiredActivationActions = [
  "Assign a dedicated Reward Signer wallet and remove OPERATOR_ROLE from that address.",
  "Assign a dedicated Game Operator wallet and revoke the bootstrap root's routine operator role.",
  "Assign dedicated Keeper and Emergency Pauser wallets.",
  "Authorize the approved Saigon Launchpad minter and remove the bootstrap root's Miner MINTER_ROLE.",
  "Remove every bootstrap mint/state role that is no longer required.",
  "Verify metadata endpoints, definition renders, caps, map hash, Treasury, and both Crystal minters.",
  "Only after all checks pass, unpause minting and gameplay in the separate activation procedure."
];
saveManifest();

console.log(`V2 Saigon suite deployed and configured PAUSED. Manifest: ${deploymentPath}`);
for (const [label, record] of Object.entries(manifest.contracts)) console.log(`${label}: ${record.address}`);
console.log(`Launch map version: ${mapVersion}`);
console.log("No NFT was minted and no contract was unpaused.");

async function grantIfMissing(contract, role, account, label) {
  await sendIf(!(await contract.hasRole(role, account)), label, () => contract.grantRole(role, account));
}

async function sendIf(condition, label, transactionFactory) {
  if (!condition) return;
  await send(label, transactionFactory);
}

async function send(label, transactionFactory) {
  const transaction = await transactionFactory();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed.`);
  manifest.setupTransactions.push({ label, hash: transaction.hash, blockNumber: receipt.blockNumber });
  manifest.updatedAt = new Date().toISOString();
  saveManifest();
  console.log(`${label}: ${transaction.hash}`);
}

async function deployOrRecover(label, artifactName, constructorArgs) {
  let record = manifest.contracts[label];
  const safeArguments = jsonSafe(constructorArgs);
  if (record) {
    if (record.artifactName !== artifactName || JSON.stringify(record.constructorArgs) !== JSON.stringify(safeArguments)) {
      throw new Error(`${label} deployment arguments differ from its checkpoint.`);
    }
    if ((await ethers.provider.getCode(record.address)) === "0x") {
      const pendingTransaction = await ethers.provider.getTransaction(record.transactionHash);
      if (!pendingTransaction) {
        throw new Error(`${label} checkpoint has no code and its deployment transaction is unavailable.`);
      }
      const receipt = await pendingTransaction.wait();
      if (!receipt || receipt.status !== 1 || (await ethers.provider.getCode(record.address)) === "0x") {
        throw new Error(`${label} checkpoint deployment did not produce contract code.`);
      }
      record.status = "deployed";
      record.blockNumber = receipt.blockNumber;
      record.deployedAt = new Date().toISOString();
      manifest.updatedAt = record.deployedAt;
      saveManifest();
    }
    return ethers.getContractAt(artifactName, record.address, deployer);
  }

  const factory = await ethers.getContractFactory(artifactName, deployer);
  const contract = await factory.deploy(...constructorArgs);
  const transaction = contract.deploymentTransaction();
  record = {
    artifactName,
    constructorArgs: safeArguments,
    address: getAddress(contract.target),
    transactionHash: transaction.hash,
    status: "broadcast",
    broadcastAt: new Date().toISOString()
  };
  manifest.contracts[label] = record;
  saveManifest();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} deployment failed.`);
  record.status = "deployed";
  record.blockNumber = receipt.blockNumber;
  record.deployedAt = new Date().toISOString();
  manifest.updatedAt = record.deployedAt;
  saveManifest();
  console.log(`${label}: ${record.address}`);
  return contract;
}

function loadManifest() {
  if (!existsSync(deploymentPath)) return null;
  return JSON.parse(readFileSync(deploymentPath, "utf8"));
}

function saveManifest() {
  mkdirSync(dirname(deploymentPath), { recursive: true });
  const temporaryPath = `${deploymentPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, deploymentPath);
}

function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
