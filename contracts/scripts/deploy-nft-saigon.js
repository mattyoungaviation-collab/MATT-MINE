import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { formatEther, getAddress, keccak256, parseEther, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_SAIGON_CONFIG_PATH,
  NFT_SAIGON_CONFIRMATION,
  NFT_SAIGON_RELEASE_ID,
  SAIGON_CHAIN_ID,
  loadNftSaigonConfig,
  validateNftSaigonNetwork
} from "./lib/nft-saigon.js";

if (process.env.MATT_MINE_NFT_SAIGON_CONFIRMATION !== NFT_SAIGON_CONFIRMATION) {
  throw new Error(`Set MATT_MINE_NFT_SAIGON_CONFIRMATION=${NFT_SAIGON_CONFIRMATION} after reviewing the Saigon config.`);
}

const expectedDeployerRaw = process.env.MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS;
const expectedDeployer = expectedDeployerRaw ? getAddress(expectedDeployerRaw) : null;
const deploymentPath = process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_SAIGON_CONFIG_PATH), "..", "deployments", "nft-saigon.json");

const { ethers } = await network.create();
const config = loadNftSaigonConfig();
await validateNftSaigonNetwork(ethers);

const signers = await ethers.getSigners();
if (signers.length !== 1) throw new Error("Configure exactly one encrypted Saigon deployment signer.");
const [deployer] = signers;
const deployerAddress = getAddress(await deployer.getAddress());
if (expectedDeployer && deployerAddress !== expectedDeployer) {
  throw new Error(`Encrypted signer resolves to ${deployerAddress}, not approved ${expectedDeployer}.`);
}
if (deployerAddress !== config.roles.contractAdmin) {
  throw new Error(
    `NUGG_DEPLOYER_PRIVATE_KEY resolves to ${deployerAddress}; Saigon requires the approved admin ${config.roles.contractAdmin}.`
  );
}
if ((await ethers.provider.getCode(deployerAddress)) !== "0x") throw new Error("Saigon deployer must be an EOA.");
for (const [label, address] of Object.entries({
  emergencyPauser: config.roles.emergencyPauser,
  gameOperator: config.roles.gameOperator,
  gameSigner: config.roles.gameSigner,
  redemptionSigner: config.roles.redemptionSigner,
  vault: config.treasury.vault
})) {
  if (getAddress(address) === deployerAddress) throw new Error(`Saigon admin cannot also be ${label}.`);
}
const deployerBalance = await ethers.provider.getBalance(deployerAddress);
const preflightPath = resolve(dirname(NFT_SAIGON_CONFIG_PATH), "..", "deployments", "saigon-deployer-preflight.json");
mkdirSync(dirname(preflightPath), { recursive: true });
writeFileSync(preflightPath, `${JSON.stringify({
  chainId: Number(SAIGON_CHAIN_ID),
  deployer: deployerAddress,
  balanceRon: formatEther(deployerBalance),
  checkedAt: new Date().toISOString()
}, null, 2)}\n`, "utf8");
if (deployerBalance < parseEther("0.25")) {
  throw new Error(
    `Saigon deployer ${deployerAddress} has ${formatEther(deployerBalance)} RON; fund at least 0.25 test RON from https://faucet.roninchain.com and rerun.`
  );
}
console.log(`Saigon deployer: ${deployerAddress} (${formatEther(deployerBalance)} RON)`);

const publicConfig = jsonSafe(config);
const configHash = keccak256(toUtf8Bytes(JSON.stringify(publicConfig)));
let manifest = loadManifest();
if (!manifest) {
  manifest = {
    schemaVersion: 1,
    scope: "MattMineNftV1Saigon",
    releaseId: NFT_SAIGON_RELEASE_ID,
    chainId: Number(SAIGON_CHAIN_ID),
    configHash,
    deployer: deployerAddress,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {}
  };
  saveManifest();
} else {
  if (manifest.scope !== "MattMineNftV1Saigon" || manifest.releaseId !== NFT_SAIGON_RELEASE_ID) {
    throw new Error("Deployment manifest belongs to a different release or scope.");
  }
  if (manifest.configHash !== configHash || getAddress(manifest.deployer) !== deployerAddress) {
    throw new Error("Deployment manifest does not match this config and deployer.");
  }
}

const matt = await deployOrRecover("MattMineSaigonMatt", [
  config.roles.contractAdmin,
  config.testTokens.initialMattSupplyWei
]);
const crystal = await deployOrRecover("MattMineSaigonCrystal", [config.roles.contractAdmin]);
const randomness = await deployOrRecover("MattMineSaigonRandomness", [
  config.roles.contractAdmin,
  config.roles.randomnessOracle
]);
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
const loadout = await deployOrRecover("MattLoadout", [
  config.roles.contractAdmin,
  miner.target,
  equipment.target,
  matt.target,
  config.treasury.vault,
  config.economy.repairPriceMattWei,
  config.roles.emergencyPauser
]);
const chest = await deployOrRecover("MattChest", [
  config.roles.contractAdmin,
  matt.target,
  equipment.target,
  randomness.target,
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
  crystal.target,
  config.roles.redemptionSigner,
  config.economy.minimumCrystalWithdrawalWei,
  config.economy.maximumDailyCrystalWithdrawalWei,
  config.roles.emergencyPauser
]);

for (const [label, contract] of Object.entries({ loadout, chest, settlement, redemption })) {
  if ((await contract.paused()) !== true) throw new Error(`${label} did not deploy paused.`);
}
for (const [label, contract] of Object.entries({ matt, crystal, randomness })) {
  if (getAddress(await contract.owner()) !== config.roles.contractAdmin) {
    throw new Error(`${label} is not owned by the approved admin.`);
  }
}
for (const [label, contract] of Object.entries({ miner, equipment, loadout, chest, settlement, redemption })) {
  if (getAddress(await contract.defaultAdmin()) !== config.roles.contractAdmin) {
    throw new Error(`${label} default admin is not the approved 0xF799 wallet.`);
  }
}
if (!(await settlement.hasRole(await settlement.RUN_MANAGER_ROLE(), config.roles.gameOperator))) {
  throw new Error("Settlement game operator role was not configured correctly.");
}

manifest.status = "deployed_paused_requires_admin_setup";
manifest.updatedAt = new Date().toISOString();
manifest.requiredPostDeploymentActions = [
  `0xF799 admin: authorize ${redemption.target} as a Crystal minter on ${crystal.target}`,
  "0xF799 admin: grant Miner progression/metadata roles and Equipment mint/loadout/state/burn roles",
  "0xF799 admin: grant Loadout game role to Settlement",
  "0xF799 admin: set all chest prices, backpack configuration, and definition pools",
  "0xF799 admin: distribute test MATT to test players",
  "Verify every constructor, owner, admin role, token, vault, signer, and paused state",
  "Only then unpause Loadout, Chest, Settlement, and Redemption for the rehearsal"
];
saveManifest();

console.log(`NFT v1 Saigon contracts deployed paused. Manifest: ${deploymentPath}`);
for (const [name, record] of Object.entries(manifest.contracts)) console.log(`${name}: ${record.address}`);
console.log("No NFT was minted and no gameplay path was unpaused.");

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
      if (receipt.status !== 1) throw new Error(`${name} deployment transaction failed; preserve the manifest.`);
      if (!receipt.contractAddress) throw new Error(`${name} receipt has no contract address.`);
      if (getAddress(receipt.contractAddress) !== getAddress(record.address)) {
        throw new Error(`${name} receipt address does not match its checkpoint.`);
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
