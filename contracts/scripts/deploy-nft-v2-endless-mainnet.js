import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, getCreateAddress, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  ENDLESS_MAINNET_CONFIG_PATH,
  ENDLESS_MAINNET_CONFIRMATION,
  ENDLESS_MAINNET_RELEASE_ID,
  loadActivatedNftV2Base,
  loadEndlessMainnetConfig
} from "./lib/nft-v2-endless-mainnet.js";
import { jsonSafe } from "./lib/nft-v2-mainnet.js";

if (process.env.MATT_MINE_ENDLESS_MAINNET_CONFIRMATION !== ENDLESS_MAINNET_CONFIRMATION) {
  throw new Error(`Set MATT_MINE_ENDLESS_MAINNET_CONFIRMATION=${ENDLESS_MAINNET_CONFIRMATION} after the read-only preflight passes.`);
}

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) throw new Error("Endless deployment requires Ronin Mainnet chain 2020.");
const config = loadEndlessMainnetConfig();
const base = loadActivatedNftV2Base(config);
const [deployer, ...extra] = await ethers.getSigners();
if (!deployer || extra.length) throw new Error("Configure exactly one encrypted Endless deployment signer.");
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== config.roles.rootAdmin) throw new Error(`Endless deployer is ${deployerAddress}; expected ${config.roles.rootAdmin}.`);

for (const [label, address] of Object.entries(base.contracts)) {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`Base ${label} has no Ronin contract code.`);
}
const deploymentPath = process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(ENDLESS_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-endless-ronin.json");
const configHash = keccak256(toUtf8Bytes(JSON.stringify(jsonSafe({
  releaseId: config.releaseId,
  chainId: config.chainId,
  baseContracts: base.contracts,
  roles: config.roles,
  versions: config.versions
}))));
let manifest = existsSync(deploymentPath) ? JSON.parse(readFileSync(deploymentPath, "utf8")) : null;
if (!manifest) {
  const latest = await ethers.provider.getTransactionCount(deployerAddress, "latest");
  const pending = await ethers.provider.getTransactionCount(deployerAddress, "pending");
  if (latest !== pending) throw new Error("The Endless deployment wallet has pending transactions.");
  manifest = {
    schemaVersion: 1,
    scope: "MattMineNftV2EndlessRonin",
    releaseId: ENDLESS_MAINNET_RELEASE_ID,
    chainId: Number(ENDLESS_MAINNET_CHAIN_ID),
    configHash,
    baseReleaseId: base.manifest.releaseId,
    baseContracts: base.contracts,
    deployer: deployerAddress,
    startingNonce: pending,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {},
    setupTransactions: [],
    versionIds: {}
  };
  save();
} else if (
  manifest.scope !== "MattMineNftV2EndlessRonin" || manifest.releaseId !== ENDLESS_MAINNET_RELEASE_ID
  || Number(manifest.chainId) !== Number(ENDLESS_MAINNET_CHAIN_ID) || manifest.configHash !== configHash
  || getAddress(manifest.deployer) !== deployerAddress
) {
  throw new Error("Existing Endless manifest belongs to another release, config, chain, or deployer.");
}

const implementationAddress = getCreateAddress({ from: deployerAddress, nonce: BigInt(manifest.startingNonce) });
const proxyAddress = getCreateAddress({ from: deployerAddress, nonce: BigInt(manifest.startingNonce) + 1n });
const implementationFactory = await ethers.getContractFactory("MattV2EndlessSettlement", deployer);
const initializationData = implementationFactory.interface.encodeFunctionData("initialize", [
  config.roles.rootAdmin,
  config.roles.emergencyPauser,
  config.roles.gameOperator,
  config.roles.configOperator,
  config.roles.rewardSigner,
  base.contracts.miner,
  base.contracts.loadout,
  base.contracts.crystalBank,
  base.contracts.passiveRewards
]);
await deployOrRecover({
  label: "EndlessSettlementImplementation",
  artifactName: "MattV2EndlessSettlement",
  args: [base.contracts.upgradeTimelock],
  nonce: Number(manifest.startingNonce),
  address: implementationAddress
});
await deployOrRecover({
  label: "EndlessSettlementProxy",
  artifactName: "MattV2ERC1967Proxy",
  args: [implementationAddress, initializationData],
  nonce: Number(manifest.startingNonce) + 1,
  address: proxyAddress
});

const endless = await ethers.getContractAt("MattV2EndlessSettlement", proxyAddress, deployer);
const miner = await ethers.getContractAt("MattV2Miner", base.contracts.miner, deployer);
const loadout = await ethers.getContractAt("MattV2Loadout", base.contracts.loadout, deployer);
const bank = await ethers.getContractAt("MattV2CrystalBank", base.contracts.crystalBank, deployer);
const passive = await ethers.getContractAt("MattV2PassiveRewards", base.contracts.passiveRewards, deployer);

await grant(miner, await miner.PROGRESSION_ROLE(), proxyAddress, "Miner progression -> Endless");
await grant(miner, await miner.LOCK_ROLE(), proxyAddress, "Miner lock -> Endless");
await grant(loadout, await loadout.GAME_ROLE(), proxyAddress, "Loadout game -> Endless");
await grant(bank, await bank.CREDIT_ROLE(), proxyAddress, "Crystal Bank credit -> Endless");
await grant(passive, await passive.SETTLEMENT_ROLE(), proxyAddress, "Passive activity -> Endless");

for (const [economyVersion, version] of Object.entries(config.versions)) {
  const existing = await endless.versions(version.versionId);
  if (!existing.approved) await send(`Approve ${economyVersion}`, () => endless.approveVersion(version.input));
  manifest.versionIds[economyVersion] = version.versionId;
  save();
}

await revoke(endless, await endless.OPERATOR_ROLE(), config.roles.rootAdmin, "Revoke root Endless operator");
await revoke(endless, await endless.CONFIG_ROLE(), config.roles.rootAdmin, "Revoke root Endless config");
await revoke(endless, await endless.PAUSER_ROLE(), config.roles.rootAdmin, "Revoke root Endless pauser");

if (!(await endless.paused())) throw new Error("Endless must remain paused after deployment.");
if (getAddress(await endless.defaultAdmin()) !== config.roles.rootAdmin) throw new Error("Endless default admin mismatch.");
if (getAddress(await endless.rewardSigner()) !== config.roles.rewardSigner) throw new Error("Endless Reward Signer mismatch.");
for (const [label, role, account] of [
  ["operator", await endless.OPERATOR_ROLE(), config.roles.gameOperator],
  ["config", await endless.CONFIG_ROLE(), config.roles.configOperator],
  ["pauser", await endless.PAUSER_ROLE(), config.roles.emergencyPauser]
]) if (!(await endless.hasRole(role, account))) throw new Error(`Dedicated Endless ${label} role is missing.`);

manifest.status = "deployed_configured_paused_requires_activation";
manifest.updatedAt = new Date().toISOString();
manifest.deploymentBlock = Math.min(...Object.values(manifest.contracts).map((record) => Number(record.blockNumber)));
manifest.requiredEnvironment = {
  MATT_MINE_ENDLESS_SETTLEMENT_ENABLED: "true",
  MATT_MINE_ENDLESS_SETTLEMENT_ADDRESS: proxyAddress,
  MATT_MINE_ENDLESS_DEPLOYMENT_BLOCK: String(manifest.deploymentBlock),
  MATT_MINE_ENDLESS_VERSION_IDS_JSON: JSON.stringify(manifest.versionIds)
};
save();
console.log(`Endless deployed and configured PAUSED. Manifest: ${deploymentPath}`);
console.log(`Endless Settlement: ${proxyAddress}`);
console.log(`Version routes: ${JSON.stringify(manifest.versionIds)}`);
console.log("No Endless reward path was unpaused or activated.");

async function deployOrRecover(step) {
  const expectedAddress = getAddress(step.address);
  let record = manifest.contracts[step.label];
  if (record) {
    if (record.artifactName !== step.artifactName || getAddress(record.address) !== expectedAddress || JSON.stringify(record.constructorArgs) !== JSON.stringify(jsonSafe(step.args))) {
      throw new Error(`${step.label} checkpoint differs from the approved deployment plan.`);
    }
    if ((await ethers.provider.getCode(expectedAddress)) !== "0x") return;
    const receipt = await ethers.provider.getTransactionReceipt(record.transactionHash);
    if (!receipt) throw new Error(`${step.label} deployment is pending. Rerun after it confirms.`);
    if (receipt.status !== 1) throw new Error(`${step.label} deployment reverted.`);
    record.status = "deployed";
    record.blockNumber = receipt.blockNumber;
    save();
    return;
  }
  const pendingNonce = await ethers.provider.getTransactionCount(deployerAddress, "pending");
  if (pendingNonce !== step.nonce) throw new Error(`${step.label} requires nonce ${step.nonce}; current pending nonce is ${pendingNonce}.`);
  const factory = await ethers.getContractFactory(step.artifactName, deployer);
  const contract = await factory.deploy(...step.args);
  if (getAddress(contract.target) !== expectedAddress) throw new Error(`${step.label} address drifted from its deployment plan.`);
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
}

async function grant(contract, role, account, label) {
  if (!(await contract.hasRole(role, account))) await send(label, () => contract.grantRole(role, account));
}
async function revoke(contract, role, account, label) {
  if (await contract.hasRole(role, account)) await send(label, () => contract.revokeRole(role, account));
}
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
