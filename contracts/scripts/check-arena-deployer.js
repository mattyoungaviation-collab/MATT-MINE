import {
  formatEther,
  formatUnits,
  getAddress
} from "ethers";
import { network } from "hardhat";
import {
  RONIN_CHAIN_ID,
  arenaConfigHash,
  arenaConstructorArgs,
  loadArenaMainnetConfig,
  validateArenaOnchainConfig
} from "./lib/arena-mainnet.js";

const expectedAddressRaw =
  process.env.MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS;
if (!expectedAddressRaw) {
  throw new Error(
    "Set MATT_MINE_ARENA_EXPECTED_DEPLOYER_ADDRESS to the approved public deployment address."
  );
}

let expectedAddress;
try {
  expectedAddress = getAddress(expectedAddressRaw);
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

const signers = await ethers.getSigners();
if (signers.length !== 1) {
  throw new Error("Configure exactly one low-balance Arena deployment signer.");
}
const [deployer] = signers;
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== expectedAddress) {
  throw new Error(
    `Encrypted signer resolves to ${deployerAddress}, not the approved ${expectedAddress}.`
  );
}

const config = loadArenaMainnetConfig();
await validateArenaOnchainConfig(ethers, config);

const protectedAddresses = new Map([
  [config.treasurySafe, "Treasury Safe"],
  [config.roles.settler, "settler"],
  [config.roles.pricer, "pricer"],
  [config.roles.emergencyPauser, "emergency pauser"]
]);
const protectedLabel = protectedAddresses.get(deployerAddress);
if (protectedLabel) {
  throw new Error(
    `The temporary Arena deployment signer cannot also be the ${protectedLabel}.`
  );
}

const [balance, nonce, code, feeData] = await Promise.all([
  ethers.provider.getBalance(deployerAddress),
  ethers.provider.getTransactionCount(deployerAddress),
  ethers.provider.getCode(deployerAddress),
  ethers.provider.getFeeData()
]);
if (code !== "0x") {
  throw new Error("The Arena deployment signer must be an externally owned account.");
}
if (feeData.gasPrice === null) {
  throw new Error("Ronin RPC did not return a gas price.");
}

const factory = await ethers.getContractFactory(
  "MattMineDailyArena",
  deployer
);
const deploymentTransaction = await factory.getDeployTransaction(
  ...arenaConstructorArgs(config)
);
const estimatedGas = await ethers.provider.estimateGas({
  ...deploymentTransaction,
  from: deployerAddress
});
const gasWithHeadroom = (estimatedGas * 120n + 99n) / 100n;
const estimatedCost = gasWithHeadroom * feeData.gasPrice;
const requiredBalance = estimatedCost * 3n;
if (balance < requiredBalance) {
  throw new Error(
    `Arena deployer has ${formatEther(balance)} RON; at least ${formatEther(requiredBalance)} RON is required for the 3x gas buffer.`
  );
}

console.log("Ronin Mainnet Arena deployment signer is ready.");
console.log(`Address: ${deployerAddress}`);
console.log(`Balance: ${formatEther(balance)} RON`);
console.log(`Transaction count: ${nonce}`);
console.log(`Gas price: ${formatUnits(feeData.gasPrice, "gwei")} gwei`);
console.log(`Estimated deployment gas: ${estimatedGas}`);
console.log(`Gas limit planning value: ${gasWithHeadroom}`);
console.log(`Estimated deployment cost: ${formatEther(estimatedCost)} RON`);
console.log(`Required 3x gas buffer: ${formatEther(requiredBalance)} RON`);
console.log(`Arena config hash: ${arenaConfigHash(config)}`);
console.log(`Treasury Safe: ${config.treasurySafe}`);
console.log("Scope: MattMineDailyArena only.");
console.log("No transaction was broadcast.");
