import { getAddress, formatEther, formatUnits } from "ethers";
import { network } from "hardhat";
import {
  RONIN_CHAIN_ID,
  configHash,
  loadMainnetConfig
} from "./lib/mainnet-config.js";

const expectedAddressRaw = process.env.MATT_MINE_EXPECTED_DEPLOYER_ADDRESS;
if (!expectedAddressRaw) {
  throw new Error(
    "Set MATT_MINE_EXPECTED_DEPLOYER_ADDRESS to the approved public deployment address."
  );
}

let expectedAddress;
try {
  expectedAddress = getAddress(expectedAddressRaw);
} catch {
  throw new Error("MATT_MINE_EXPECTED_DEPLOYER_ADDRESS is not a valid address.");
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
  throw new Error("Configure exactly one low-balance deployment signer.");
}

const [deployer] = signers;
const deployerAddress = getAddress(await deployer.getAddress());
if (deployerAddress !== expectedAddress) {
  throw new Error(
    `Encrypted signer resolves to ${deployerAddress}, not the approved ${expectedAddress}.`
  );
}

const config = loadMainnetConfig();
const protectedAddresses = new Map([
  [config.roles.contractAdminMultisig, "contract admin Safe"],
  [config.roles.priceManager, "price manager"],
  [config.roles.configManager, "configuration manager"],
  [config.roles.pauser, "emergency pauser"],
  [config.roles.rewardPublisher, "reward publisher"],
  [config.roles.treasuryManager, "treasury manager"],
  [config.treasuries.operations, "operations treasury"],
  [config.treasuries.passRewards, "pass rewards treasury"],
  [config.treasuries.growth, "growth treasury"],
  [config.treasuries.futureRewards, "future rewards treasury"],
  [config.treasuries.reserve, "reserve treasury"]
]);
const protectedLabel = protectedAddresses.get(deployerAddress);
if (protectedLabel) {
  throw new Error(
    `The temporary deployment signer cannot also be the ${protectedLabel}.`
  );
}

const [balance, nonce, code, feeData] = await Promise.all([
  ethers.provider.getBalance(deployerAddress),
  ethers.provider.getTransactionCount(deployerAddress),
  ethers.provider.getCode(deployerAddress),
  ethers.provider.getFeeData()
]);
if (code !== "0x") {
  throw new Error("The deployment signer must be an externally owned account.");
}
if (feeData.gasPrice === null) {
  throw new Error("Ronin RPC did not return a gas price.");
}

// Measured test deployments consume about 4.75 million gas including role
// finalization. Use five million gas and require a 3x balance buffer.
const estimatedDeploymentGas = 5_000_000n;
const estimatedCost = estimatedDeploymentGas * feeData.gasPrice;
const requiredBalance = estimatedCost * 3n;
if (balance < requiredBalance) {
  throw new Error(
    `Deployment signer has ${formatEther(balance)} RON; at least ${formatEther(requiredBalance)} RON is required for the 3x gas buffer.`
  );
}

console.log("Ronin Mainnet deployment signer is ready.");
console.log(`Address: ${deployerAddress}`);
console.log(`Balance: ${formatEther(balance)} RON`);
console.log(`Transaction count: ${nonce}`);
console.log(`Gas price: ${formatUnits(feeData.gasPrice, "gwei")} gwei`);
console.log(`Estimated deployment cost: ${formatEther(estimatedCost)} RON`);
console.log(`Required 3x gas buffer: ${formatEther(requiredBalance)} RON`);
console.log(`Config hash: ${configHash(config)}`);
console.log("No transaction was broadcast.");
