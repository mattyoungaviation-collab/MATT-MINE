import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_CONFIG_PATH,
  NFT_MAINNET_CONFIRMATION,
  NFT_RELEASE_ID,
  RONIN_CHAIN_ID,
  loadNftMainnetConfig,
  validateNftOnchainConfig
} from "./lib/nft-mainnet.js";

if (process.env.MATT_MINE_NFT_MAINNET_CONFIRMATION !== NFT_MAINNET_CONFIRMATION) {
  throw new Error(
    `Set MATT_MINE_NFT_MAINNET_CONFIRMATION=${NFT_MAINNET_CONFIRMATION} only after config, tests, audit, and multisig review are approved.`
  );
}

const expectedDeployerRaw = process.env.MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS;
if (!expectedDeployerRaw) throw new Error("Set MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS to the approved low-balance deployer.");
const expectedDeployer = getAddress(expectedDeployerRaw);
const deploymentPath = process.env.MATT_MINE_NFT_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_CONFIG_PATH), "..", "deployments", "nft-ronin.json");

const { ethers } = await network.create();
const config = loadNftMainnetConfig();
await validateNftOnchainConfig(ethers, config);

const signers = await ethers.getSigners();
if (signers.length !== 1) throw new Error("Configure exactly one encrypted NFT deployment signer.");
const [deployer] = signers;
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== expectedDeployer) {
  throw new Error(`Encrypted signer resolves to ${deployerAddress}, not approved ${expectedDeployer}.`);
}
if ((await ethers.provider.getCode(deployerAddress)) !== "0x") throw new Error("NFT deployer must be an EOA.");
for (const [label, address] of Object.entries({
  ...config.roles,
  vault: config.treasury.vault
})) {
  if (getAddress(address) === deployerAddress) throw new Error(`Temporary deployer cannot also be ${label}.`);
}

const publicConfig = jsonSafe(config);
const configHash = keccak256(toUtf8Bytes(JSON.stringify(publicConfig)));
let manifest = loadManifest();
if (!manifest) {
  manifest = {
    schemaVersion: 1,
    scope: "MattMineNftV1Only",
    releaseId: NFT_RELEASE_ID,
    chainId: Number(RONIN_CHAIN_ID),
    configHash,
    deployer: deployerAddress,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {}
  };
  saveManifest();
} else {
  if (manifest.scope !== "MattMineNftV1Only" || manifest.releaseId !== NFT_RELEASE_ID) {
    throw new Error("Deployment manifest belongs to a different release or scope.");
  }
  if (manifest.configHash !== configHash || getAddress(manifest.deployer) !== deployerAddress) {
    throw new Error("Deployment manifest does not match this config and deployer.");
  }
}

const miner = await deployOrRecover("MattMiner", [
  config.roles.contractAdmin,
  config.metadata.minerBaseUri,
  config.metadata.minerContractUri
]);
const equipment = await deployOrRecover("MattEquipment", [
  config.roles.contractAdmin,
  config.metadata.equipmentBaseUri,
  config.metadata.equipmentContractUri
]);
const vrfAdapter = await deployOrRecover("MattMineVRFV25Adapter", [
  config.protocol.vrfCoordinator,
  config.protocol.vrfSubscriptionId,
  config.protocol.vrfKeyHash,
  config.roles.contractAdmin,
  config.vrf.requestConfirmations,
  config.vrf.coordinatorCallbackGasLimit,
  config.vrf.consumerCallbackGasLimit
]);
const loadout = await deployOrRecover("MattLoadout", [
  config.roles.contractAdmin,
  miner.target,
  equipment.target,
  config.protocol.mattToken,
  config.treasury.vault,
  config.economy.repairPriceMattWei,
  config.roles.emergencyPauser
]);
const chest = await deployOrRecover("MattChest", [
  config.roles.contractAdmin,
  config.protocol.mattToken,
  equipment.target,
  vrfAdapter.target,
  config.treasury.vault,
  config.roles.emergencyPauser
]);
const settlement = await deployOrRecover("MattGameSettlement", [
  config.roles.contractAdmin,
  miner.target,
  loadout.target,
  config.roles.gameSigner,
  config.roles.gameOperator,
  config.roles.emergencyPauser
]);
const redemption = await deployOrRecover("MattCrystalRedemption", [
  config.roles.contractAdmin,
  config.protocol.crystalToken,
  config.roles.redemptionSigner,
  config.economy.minimumCrystalWithdrawalWei,
  config.economy.maximumDailyCrystalWithdrawalWei,
  config.roles.emergencyPauser
]);

for (const [label, contract] of Object.entries({ loadout, chest, settlement, redemption })) {
  if ((await contract.paused()) !== true) throw new Error(`${label} did not deploy paused.`);
}

manifest.status = "deployed_paused_requires_safe_setup";
manifest.updatedAt = new Date().toISOString();
manifest.requiredPostDeploymentActions = [
  `0xF799 admin: set ${chest.target} as consumer on VRF adapter ${vrfAdapter.target}`,
  `0xF799 VRF subscription owner: add ${vrfAdapter.target} as consumer on the coordinator subscription`,
  `0xF799 Crystal token owner: grant mint permission to ${redemption.target}`,
  "0xF799 admin: grant Miner progression/metadata roles and Equipment mint/loadout/state/burn roles",
  "0xF799 admin: grant Loadout game role to settlement",
  "0xF799 admin: set all chest prices, backpack configuration, and definition pools",
  "Verify exact source, constructors, role map, token addresses, vault, metadata, and paused state",
  "Only then unpause from the 0xF799 admin wallet"
];
saveManifest();

console.log(`NFT v1 contracts deployed paused. Manifest: ${deploymentPath}`);
for (const [name, record] of Object.entries(manifest.contracts)) console.log(`${name}: ${record.address}`);
console.log("No NFT was minted, no contract was funded, and no gameplay path was unpaused.");

async function deployOrRecover(name, constructorArgs) {
  let record = manifest.contracts[name];
  if (record) {
    if (JSON.stringify(record.constructorArgs) !== JSON.stringify(jsonSafe(constructorArgs))) {
      throw new Error(`${name} constructor arguments differ from the checkpoint.`);
    }
    const code = await ethers.provider.getCode(record.address);
    if (code !== "0x") return ethers.getContractAt(name, record.address, deployer);
    if (record.transactionHash) {
      const receipt = await ethers.provider.getTransactionReceipt(record.transactionHash);
      if (!receipt) throw new Error(`${name} transaction is pending. Rerun after it is mined.`);
      if (receipt.status !== 1) throw new Error(`${name} deployment transaction failed; preserve the manifest for review.`);
      if (!receipt.contractAddress) throw new Error(`${name} receipt has no contract address.`);
      if (getAddress(receipt.contractAddress) !== getAddress(record.address)) {
        throw new Error(`${name} receipt address does not match its deployment checkpoint.`);
      }
      record.address = getAddress(receipt.contractAddress);
      record.status = "deployed";
      saveManifest();
      return ethers.getContractAt(name, record.address, deployer);
    }
    throw new Error(`${name} checkpoint has no code or recoverable transaction.`);
  }

  const factory = await ethers.getContractFactory(name, deployer);
  const contract = await factory.deploy(...constructorArgs);
  const transaction = contract.deploymentTransaction();
  record = {
    contractName: name,
    constructorArgs: jsonSafe(constructorArgs),
    address: getAddress(contract.target),
    transactionHash: transaction.hash,
    status: "broadcast",
    broadcastAt: new Date().toISOString()
  };
  manifest.contracts[name] = record;
  manifest.updatedAt = record.broadcastAt;
  saveManifest();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${name} deployment transaction failed.`);
  record.status = "deployed";
  record.blockNumber = receipt.blockNumber;
  record.deployedAt = new Date().toISOString();
  manifest.updatedAt = record.deployedAt;
  saveManifest();
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
