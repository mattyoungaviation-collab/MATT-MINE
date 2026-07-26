import { network } from "hardhat";
import {
  DEPLOYMENT_PATH,
  RONIN_CHAIN_ID,
  configHash,
  loadDeploymentManifest,
  loadMainnetConfig,
  validateOnchainConfig,
  writeDeploymentManifest
} from "./lib/mainnet-config.js";

const REQUIRED_CONFIRMATION = "DEPLOY_MATT_MINE_TO_RONIN_MAINNET";
if (process.env.MATT_MINE_MAINNET_CONFIRMATION !== REQUIRED_CONFIRMATION) {
  throw new Error(
    `Set MATT_MINE_MAINNET_CONFIRMATION=${REQUIRED_CONFIRMATION} only after the final config and audit are approved.`
  );
}

const { ethers } = await network.create();
const config = loadMainnetConfig();
await validateOnchainConfig(ethers, config);

const signers = await ethers.getSigners();
if (signers.length !== 1) {
  throw new Error("Configure exactly one low-balance deployment signer");
}
const [deployer] = signers;
const deployerAddress = await deployer.getAddress();
if (deployerAddress === config.roles.contractAdminMultisig) {
  throw new Error("The temporary deployer must not be the contract admin multisig");
}

const adminCode = await ethers.provider.getCode(
  config.roles.contractAdminMultisig
);
if (adminCode === "0x") {
  throw new Error("The configured contract admin is not a deployed multisig");
}

const currentConfigHash = configHash(config);
let manifest = loadDeploymentManifest();
if (manifest !== null) {
  if (
    manifest.chainId !== Number(RONIN_CHAIN_ID)
    || manifest.configHash !== currentConfigHash
  ) {
    throw new Error(
      "Existing deployment record belongs to a different chain or configuration"
    );
  }
  if (manifest.deployer !== deployerAddress) {
    throw new Error(
      "A partial deployment must be resumed with the original low-balance deployment signer"
    );
  }
  if (manifest.status === "verified") {
    console.log(`Verified deployment already exists at ${DEPLOYMENT_PATH}`);
    process.exit(0);
  }
} else {
  manifest = {
    schemaVersion: 1,
    releaseId: config.releaseId,
    chainId: Number(RONIN_CHAIN_ID),
    configHash: currentConfigHash,
    deployer: deployerAddress,
    status: "partial",
    createdAt: new Date().toISOString(),
    contracts: {}
  };
  writeDeploymentManifest(manifest);
}

function serializableArguments(argumentsList) {
  return argumentsList.map((value) =>
    typeof value === "bigint" ? value.toString() : value
  );
}

async function deployOrAttach(label, contractName, constructorArgs) {
  const existing = manifest.contracts[label];
  if (existing?.address) {
    if ((await ethers.provider.getCode(existing.address)) === "0x") {
      throw new Error(`${label} deployment record has no code`);
    }
    console.log(`${label}: resuming at ${existing.address}`);
    return ethers.getContractAt(contractName, existing.address, deployer);
  }

  console.log(`${label}: deploying...`);
  const contract = await ethers.deployContract(
    contractName,
    constructorArgs,
    deployer
  );
  const deploymentTransaction = contract.deploymentTransaction();
  const receipt = await deploymentTransaction.wait();
  const address = await contract.getAddress();
  manifest.contracts[label] = {
    contractName,
    address,
    transactionHash: deploymentTransaction.hash,
    blockNumber: receipt.blockNumber,
    constructorArgs: serializableArguments(constructorArgs)
  };
  manifest.updatedAt = new Date().toISOString();
  writeDeploymentManifest(manifest);
  console.log(`${label}: ${address}`);
  return contract;
}

const pass = await deployOrAttach("MattMinePass", "MattMinePass", [
  config.roles.contractAdminMultisig,
  config.roles.priceManager,
  config.roles.pauser,
  config.treasuries.operations,
  config.treasuries.passRewards,
  config.treasuries.growth,
  config.pass.initialPriceRonWei,
  config.pass.minimumPriceRonWei,
  config.pass.maximumPriceRonWei
]);

const executor = await deployOrAttach(
  "MattMineSwapExecutor",
  "MattMineSwapExecutor",
  [
    deployerAddress,
    config.roles.pauser,
    config.protocol.katanaRouter,
    config.protocol.wrappedRon,
    config.protocol.mattToken
  ]
);

const rewards = await deployOrAttach("MattMineRewards", "MattMineRewards", [
  config.protocol.mattToken,
  config.roles.contractAdminMultisig,
  config.roles.rewardPublisher,
  config.roles.treasuryManager,
  config.roles.pauser,
  config.treasuries.reserve
]);

const runs = await deployOrAttach("MattMineRuns", "MattMineRuns", [
  await pass.getAddress(),
  config.protocol.mattToken,
  await executor.getAddress(),
  config.roles.contractAdminMultisig,
  config.roles.priceManager,
  config.roles.configManager,
  config.roles.pauser,
  await rewards.getAddress(),
  config.treasuries.futureRewards,
  config.treasuries.reserve,
  config.paidRuns.initialPriceRonWei,
  config.paidRuns.minimumPriceRonWei,
  config.paidRuns.maximumPriceRonWei
]);

const runsRole = await executor.RUNS_ROLE();
if (!(await executor.hasRole(runsRole, await runs.getAddress()))) {
  console.log("MattMineSwapExecutor: authorizing MattMineRuns...");
  await (
    await executor.grantRole(runsRole, await runs.getAddress())
  ).wait();
}

const defaultAdminRole = await executor.DEFAULT_ADMIN_ROLE();
if (
  !(await executor.hasRole(
    defaultAdminRole,
    config.roles.contractAdminMultisig
  ))
) {
  console.log("MattMineSwapExecutor: transferring admin to multisig...");
  await (
    await executor.grantRole(
      defaultAdminRole,
      config.roles.contractAdminMultisig
    )
  ).wait();
}
if (await executor.hasRole(defaultAdminRole, deployerAddress)) {
  console.log("MattMineSwapExecutor: removing temporary deployer admin...");
  await (
    await executor.renounceRole(defaultAdminRole, deployerAddress)
  ).wait();
}

if (
  !(await executor.hasRole(runsRole, await runs.getAddress()))
  || !(await executor.hasRole(
    defaultAdminRole,
    config.roles.contractAdminMultisig
  ))
  || (await executor.hasRole(defaultAdminRole, deployerAddress))
) {
  throw new Error("Post-deployment role checks failed");
}

manifest.status = "deployed_unverified";
manifest.updatedAt = new Date().toISOString();
manifest.executorBootstrapFinalized = true;
writeDeploymentManifest(manifest);

console.log("MATT Mine contracts deployed with final roles in place.");
console.log(`Deployment record: ${DEPLOYMENT_PATH}`);
console.log("Run the Sourcify verification command before funding any contract.");
