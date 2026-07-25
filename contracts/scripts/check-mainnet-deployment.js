import { formatEther, getAddress } from "ethers";
import { network } from "hardhat";
import {
  RONIN_CHAIN_ID,
  configHash,
  loadDeploymentManifest,
  loadMainnetConfig,
  validateOnchainConfig
} from "./lib/mainnet-config.js";

const { ethers } = await network.create();
const config = loadMainnetConfig();
const deployment = loadDeploymentManifest();

if (deployment === null) {
  throw new Error("The Ronin deployment manifest is missing.");
}
if (deployment.chainId !== Number(RONIN_CHAIN_ID)) {
  throw new Error(
    `Deployment manifest targets chain ${deployment.chainId}; expected ${RONIN_CHAIN_ID}.`
  );
}
if (deployment.configHash !== configHash(config)) {
  throw new Error("Deployment manifest does not match the approved configuration.");
}
if (!["deployed_unverified", "verified"].includes(deployment.status)) {
  throw new Error(`Deployment manifest has incomplete status ${deployment.status}.`);
}

await validateOnchainConfig(ethers, config);

function deployedAddress(label) {
  const address = deployment.contracts?.[label]?.address;
  if (!address) {
    throw new Error(`${label} is missing from the deployment manifest.`);
  }
  return getAddress(address);
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}; expected ${expected}.`);
  }
}

function expectAddress(actual, expected, label) {
  expectEqual(getAddress(actual), getAddress(expected), label);
}

async function expectRole(contract, role, account, expected, label) {
  const actual = await contract.hasRole(role, account);
  expectEqual(actual, expected, label);
}

const addresses = {
  pass: deployedAddress("MattMinePass"),
  executor: deployedAddress("MattMineSwapExecutor"),
  rewards: deployedAddress("MattMineRewards"),
  runs: deployedAddress("MattMineRuns")
};

for (const [label, address] of Object.entries(addresses)) {
  if ((await ethers.provider.getCode(address)) === "0x") {
    throw new Error(`${label} has no deployed bytecode at ${address}.`);
  }
}

const [pass, executor, rewards, runs] = await Promise.all([
  ethers.getContractAt("MattMinePass", addresses.pass),
  ethers.getContractAt("MattMineSwapExecutor", addresses.executor),
  ethers.getContractAt("MattMineRewards", addresses.rewards),
  ethers.getContractAt("MattMineRuns", addresses.runs)
]);

const deployer = getAddress(deployment.deployer);
const safe = config.roles.contractAdminMultisig;

expectAddress(
  await pass.operationsTreasury(),
  config.treasuries.operations,
  "Pass operations treasury"
);
expectAddress(
  await pass.rewardsTreasury(),
  config.treasuries.passRewards,
  "Pass rewards treasury"
);
expectAddress(
  await pass.growthTreasury(),
  config.treasuries.growth,
  "Pass growth treasury"
);
expectEqual(
  await pass.passPriceRon(),
  config.pass.initialPriceRonWei,
  "Pass price"
);
expectEqual(
  await pass.minPassPriceRon(),
  config.pass.minimumPriceRonWei,
  "Pass minimum price"
);
expectEqual(
  await pass.maxPassPriceRon(),
  config.pass.maximumPriceRonWei,
  "Pass maximum price"
);
expectEqual(await pass.paused(), false, "Pass pause state");
expectEqual(await pass.OPERATIONS_BPS(), 5_000n, "Pass operations share");
expectEqual(await pass.REWARDS_BPS(), 3_000n, "Pass rewards share");
await expectRole(
  pass,
  await pass.DEFAULT_ADMIN_ROLE(),
  safe,
  true,
  "Pass Safe admin role"
);
await expectRole(
  pass,
  await pass.PRICE_MANAGER_ROLE(),
  config.roles.priceManager,
  true,
  "Pass price manager role"
);
await expectRole(
  pass,
  await pass.PAUSER_ROLE(),
  config.roles.pauser,
  true,
  "Pass pauser role"
);
await expectRole(
  pass,
  await pass.DEFAULT_ADMIN_ROLE(),
  deployer,
  false,
  "Pass deployer admin removal"
);

expectAddress(
  await executor.katanaRouter(),
  config.protocol.katanaRouter,
  "Swap executor router"
);
expectAddress(
  await executor.wrappedRon(),
  config.protocol.wrappedRon,
  "Swap executor WRON"
);
expectAddress(
  await executor.mattToken(),
  config.protocol.mattToken,
  "Swap executor MATT"
);
expectEqual(await executor.paused(), false, "Swap executor pause state");
await expectRole(
  executor,
  await executor.DEFAULT_ADMIN_ROLE(),
  safe,
  true,
  "Swap executor Safe admin role"
);
await expectRole(
  executor,
  await executor.PAUSER_ROLE(),
  config.roles.pauser,
  true,
  "Swap executor pauser role"
);
await expectRole(
  executor,
  await executor.RUNS_ROLE(),
  addresses.runs,
  true,
  "Swap executor Runs authorization"
);
await expectRole(
  executor,
  await executor.DEFAULT_ADMIN_ROLE(),
  deployer,
  false,
  "Swap executor deployer admin removal"
);

expectAddress(
  await rewards.mattToken(),
  config.protocol.mattToken,
  "Rewards MATT"
);
expectAddress(
  await rewards.reserveTreasury(),
  config.treasuries.reserve,
  "Rewards reserve treasury"
);
expectEqual(await rewards.paused(), false, "Rewards pause state");
expectEqual(await rewards.totalReservedMatt(), 0n, "Reserved MATT before funding");
await expectRole(
  rewards,
  await rewards.DEFAULT_ADMIN_ROLE(),
  safe,
  true,
  "Rewards Safe admin role"
);
await expectRole(
  rewards,
  await rewards.REWARD_PUBLISHER_ROLE(),
  config.roles.rewardPublisher,
  true,
  "Rewards publisher role"
);
await expectRole(
  rewards,
  await rewards.TREASURY_ROLE(),
  config.roles.treasuryManager,
  true,
  "Rewards treasury role"
);
await expectRole(
  rewards,
  await rewards.PAUSER_ROLE(),
  config.roles.pauser,
  true,
  "Rewards pauser role"
);
await expectRole(
  rewards,
  await rewards.DEFAULT_ADMIN_ROLE(),
  deployer,
  false,
  "Rewards deployer admin removal"
);

expectAddress(await runs.passContract(), addresses.pass, "Runs pass contract");
expectAddress(
  await runs.mattToken(),
  config.protocol.mattToken,
  "Runs MATT"
);
expectAddress(
  await runs.swapExecutor(),
  addresses.executor,
  "Runs swap executor"
);
expectAddress(
  await runs.currentRewardsVault(),
  addresses.rewards,
  "Runs current rewards vault"
);
expectAddress(
  await runs.futureRewardsTreasury(),
  config.treasuries.futureRewards,
  "Runs future rewards treasury"
);
expectAddress(
  await runs.reserveTreasury(),
  config.treasuries.reserve,
  "Runs reserve treasury"
);
expectEqual(
  await runs.paidRunPriceRon(),
  config.paidRuns.initialPriceRonWei,
  "Paid-run price"
);
expectEqual(
  await runs.minPaidRunPriceRon(),
  config.paidRuns.minimumPriceRonWei,
  "Paid-run minimum price"
);
expectEqual(
  await runs.maxPaidRunPriceRon(),
  config.paidRuns.maximumPriceRonWei,
  "Paid-run maximum price"
);
expectEqual(await runs.paused(), false, "Runs pause state");
expectEqual(await runs.CURRENT_REWARDS_BPS(), 7_000n, "Current rewards share");
expectEqual(await runs.FUTURE_REWARDS_BPS(), 2_000n, "Future rewards share");
expectEqual(await runs.MAX_DAILY_PAID_RUNS(), 10n, "Daily paid-run cap");
await expectRole(
  runs,
  await runs.DEFAULT_ADMIN_ROLE(),
  safe,
  true,
  "Runs Safe admin role"
);
await expectRole(
  runs,
  await runs.PRICE_MANAGER_ROLE(),
  config.roles.priceManager,
  true,
  "Runs price manager role"
);
await expectRole(
  runs,
  await runs.CONFIG_MANAGER_ROLE(),
  config.roles.configManager,
  true,
  "Runs configuration manager role"
);
await expectRole(
  runs,
  await runs.PAUSER_ROLE(),
  config.roles.pauser,
  true,
  "Runs pauser role"
);
await expectRole(
  runs,
  await runs.DEFAULT_ADMIN_ROLE(),
  deployer,
  false,
  "Runs deployer admin removal"
);

const matt = new ethers.Contract(
  config.protocol.mattToken,
  ["function balanceOf(address) view returns (uint256)"],
  ethers.provider
);
const [
  passRon,
  executorRon,
  rewardsRon,
  runsRon,
  executorMatt,
  rewardsMatt,
  runsMatt
] = await Promise.all([
  ethers.provider.getBalance(addresses.pass),
  ethers.provider.getBalance(addresses.executor),
  ethers.provider.getBalance(addresses.rewards),
  ethers.provider.getBalance(addresses.runs),
  matt.balanceOf(addresses.executor),
  matt.balanceOf(addresses.rewards),
  matt.balanceOf(addresses.runs)
]);

for (const [label, value] of Object.entries({
  "Pass RON balance": passRon,
  "Swap executor RON balance": executorRon,
  "Rewards RON balance": rewardsRon,
  "Runs RON balance": runsRon,
  "Swap executor MATT balance": executorMatt,
  "Rewards MATT balance": rewardsMatt,
  "Runs MATT balance": runsMatt
})) {
  expectEqual(value, 0n, `${label} before funding`);
}

console.log("Ronin Mainnet deployment is ready for a controlled smoke test.");
console.log(`Pass: ${addresses.pass}`);
console.log(`Swap executor: ${addresses.executor}`);
console.log(`Rewards: ${addresses.rewards}`);
console.log(`Paid runs: ${addresses.runs}`);
console.log(`Pass price: ${formatEther(await pass.passPriceRon())} RON`);
console.log(`Paid-run price: ${formatEther(await runs.paidRunPriceRon())} RON`);
console.log("All contracts are unpaused and unfunded.");
console.log("All approved roles, treasuries, protocol addresses, and limits match.");
console.log("The temporary deployer has no administrator role.");
console.log("No transaction was broadcast.");
