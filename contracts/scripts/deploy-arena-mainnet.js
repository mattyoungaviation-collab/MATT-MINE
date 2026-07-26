import {
  getAddress,
  getCreateAddress
} from "ethers";
import { network } from "hardhat";
import {
  ARENA_DEPLOYMENT_PATH,
  ARENA_DEPLOYMENT_SCOPE,
  ARENA_MAINNET_CONFIRMATION,
  RONIN_CHAIN_ID,
  arenaConfigHash,
  arenaConstructorArgs,
  assertArenaManifest,
  loadArenaDeploymentManifest,
  loadArenaMainnetConfig,
  validateArenaOnchainConfig,
  verifyArenaDeploymentState,
  writeArenaDeploymentManifest
} from "./lib/arena-mainnet.js";

if (
  process.env.MATT_MINE_ARENA_MAINNET_CONFIRMATION
  !== ARENA_MAINNET_CONFIRMATION
) {
  throw new Error(
    `Set MATT_MINE_ARENA_MAINNET_CONFIRMATION=${ARENA_MAINNET_CONFIRMATION} only after the isolated Arena contract, config, and audit are approved.`
  );
}

const expectedDeployerRaw =
  process.env.MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS;
if (!expectedDeployerRaw) {
  throw new Error(
    "Set MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS to the approved public deployment address."
  );
}
let expectedDeployer;
try {
  expectedDeployer = getAddress(expectedDeployerRaw);
} catch {
  throw new Error(
    "MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS is not a valid address."
  );
}

const { ethers } = await network.create();
const connectedNetwork = await ethers.provider.getNetwork();
if (connectedNetwork.chainId !== RONIN_CHAIN_ID) {
  throw new Error(
    `Connected to chain ${connectedNetwork.chainId}; expected Ronin Mainnet ${RONIN_CHAIN_ID}.`
  );
}

const config = loadArenaMainnetConfig();
await validateArenaOnchainConfig(ethers, config);

const signers = await ethers.getSigners();
if (signers.length !== 1) {
  throw new Error("Configure exactly one low-balance Arena deployment signer.");
}
const [deployer] = signers;
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== expectedDeployer) {
  throw new Error(
    `Encrypted signer resolves to ${deployerAddress}, not the approved ${expectedDeployer}.`
  );
}
for (const [address, label] of new Map([
  [config.treasurySafe, "Treasury Safe"],
  [config.roles.settler, "settler"],
  [config.roles.pricer, "pricer"],
  [config.roles.emergencyPauser, "emergency pauser"]
])) {
  if (deployerAddress === address) {
    throw new Error(
      `The temporary Arena deployer cannot also be the ${label}.`
    );
  }
}
if ((await ethers.provider.getCode(deployerAddress)) !== "0x") {
  throw new Error("The Arena deployer must be an externally owned account.");
}

const currentConfigHash = arenaConfigHash(config);
const constructorArgs = arenaConstructorArgs(config);
let manifest = loadArenaDeploymentManifest();
if (manifest === null) {
  manifest = {
    schemaVersion: 1,
    scope: ARENA_DEPLOYMENT_SCOPE,
    releaseId: config.releaseId,
    chainId: Number(RONIN_CHAIN_ID),
    configHash: currentConfigHash,
    deployer: deployerAddress,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {}
  };
  writeArenaDeploymentManifest(manifest);
} else {
  assertArenaManifest(manifest, config, deployerAddress);
  if (manifest.status === "verified_exact") {
    console.log(
      `Exact-match verified Arena deployment already exists at ${ARENA_DEPLOYMENT_PATH}.`
    );
    process.exit(0);
  }
}

let record = manifest.contracts.MattMineDailyArena;
if (record?.contractName && record.contractName !== "MattMineDailyArena") {
  throw new Error("Arena checkpoint contains an unexpected contract name.");
}
if (
  record?.constructorArgs
  && JSON.stringify(record.constructorArgs)
    !== JSON.stringify(constructorArgs)
) {
  throw new Error(
    "Arena checkpoint constructor arguments do not match the approved configuration."
  );
}

if (!record) {
  const deploymentNonce = await ethers.provider.getTransactionCount(
    deployerAddress,
    "pending"
  );
  const predictedAddress = getCreateAddress({
    from: deployerAddress,
    nonce: deploymentNonce
  });
  record = {
    contractName: "MattMineDailyArena",
    status: "prepared",
    predictedAddress,
    deployerNonce: deploymentNonce,
    constructorArgs
  };
  manifest.contracts.MattMineDailyArena = record;
  manifest.updatedAt = new Date().toISOString();
  writeArenaDeploymentManifest(manifest);
  console.log(
    `MattMineDailyArena: checkpoint prepared for ${predictedAddress}.`
  );
}

const predictedAddress = getAddress(record.predictedAddress);
let deployedCode = await ethers.provider.getCode(predictedAddress);
if (record.address && getAddress(record.address) !== predictedAddress) {
  throw new Error(
    "Arena checkpoint address does not match the predicted CREATE address."
  );
}

if (deployedCode === "0x" && record.transactionHash) {
  const receipt = await ethers.provider.getTransactionReceipt(
    record.transactionHash
  );
  if (receipt === null) {
    throw new Error(
      `Arena deployment transaction ${record.transactionHash} is pending or unavailable. Do not redeploy; rerun after it is mined.`
    );
  }
  if (receipt.status !== 1) {
    throw new Error(
      `Arena deployment transaction ${record.transactionHash} failed. Preserve the checkpoint for review.`
    );
  }
  deployedCode = await ethers.provider.getCode(predictedAddress);
  if (deployedCode === "0x") {
    throw new Error(
      "Arena deployment transaction succeeded but no code exists at the predicted address."
    );
  }
}

if (deployedCode === "0x") {
  const pendingNonce = await ethers.provider.getTransactionCount(
    deployerAddress,
    "pending"
  );
  if (pendingNonce !== record.deployerNonce) {
    throw new Error(
      `Arena checkpoint reserved deployer nonce ${record.deployerNonce}, but the current pending nonce is ${pendingNonce}. No deployment was sent because resuming would be ambiguous.`
    );
  }

  console.log("MattMineDailyArena: deploying isolated contract...");
  const factory = await ethers.getContractFactory(
    "MattMineDailyArena",
    deployer
  );
  const arena = await factory.deploy(...constructorArgs, {
    nonce: record.deployerNonce
  });
  const transaction = arena.deploymentTransaction();
  record.status = "broadcast";
  record.transactionHash = transaction.hash;
  record.broadcastAt = new Date().toISOString();
  manifest.updatedAt = record.broadcastAt;
  writeArenaDeploymentManifest(manifest);

  const receipt = await transaction.wait();
  if (receipt.status !== 1) {
    throw new Error(
      `Arena deployment transaction ${transaction.hash} did not succeed.`
    );
  }
  const address = getAddress(await arena.getAddress());
  if (address !== predictedAddress) {
    throw new Error(
      `Arena deployed to ${address}; predicted checkpoint was ${predictedAddress}.`
    );
  }
  record.address = address;
  record.blockNumber = receipt.blockNumber;
  record.status = "deployed";
  record.deployedAt = new Date().toISOString();
  manifest.updatedAt = record.deployedAt;
  writeArenaDeploymentManifest(manifest);
  console.log(`MattMineDailyArena: ${address}`);
} else {
  record.address = predictedAddress;
  record.status = "deployed";
  record.recoveredAt ??= new Date().toISOString();
  manifest.updatedAt = new Date().toISOString();
  writeArenaDeploymentManifest(manifest);
  console.log(`MattMineDailyArena: resuming at ${predictedAddress}`);
}

await verifyArenaDeploymentState(ethers, config, manifest, {
  requireEmptyBalances: true
});

manifest.status = "deployed_unverified";
manifest.updatedAt = new Date().toISOString();
manifest.postDeploymentChecksAt = manifest.updatedAt;
writeArenaDeploymentManifest(manifest);

console.log("MattMineDailyArena deployed with final roles in place.");
console.log(`Deployment record: ${ARENA_DEPLOYMENT_PATH}`);
console.log("The four existing MATT Mine contracts were not touched.");
console.log("Run exact-match Sourcify verification before activation or funding.");
