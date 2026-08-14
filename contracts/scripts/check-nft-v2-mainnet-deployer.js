import { formatEther, getAddress, parseEther } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_ROOT,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";
import {
  NFT_V2_CONTEXT_DEPLOYMENT_GAS_CEILING,
  buildNftV2DeploymentPlan,
  requiresPriorNftV2Deployments
} from "./lib/nft-v2-deployment-plan.js";

const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const signers = await ethers.getSigners();
if (signers.length !== 1) throw new Error("Configure exactly one encrypted V2 deployment signer.");
const [deployer] = signers;
const address = getAddress(await deployer.getAddress());
if (address !== NFT_V2_ROOT) throw new Error(`NUGG_DEPLOYER_PRIVATE_KEY resolves to ${address}; expected ${NFT_V2_ROOT}.`);
if ((await ethers.provider.getCode(address)) !== "0x") throw new Error("V2 deployer must be an EOA.");
const [pendingNonce, latestNonce, balance, feeData] = await Promise.all([
  ethers.provider.getTransactionCount(address, "pending"),
  ethers.provider.getTransactionCount(address, "latest"),
  ethers.provider.getBalance(address),
  ethers.provider.getFeeData()
]);
if (pendingNonce !== latestNonce) throw new Error("The deployment wallet has pending transactions. Clear them before deployment.");
const plan = await buildNftV2DeploymentPlan(ethers, config, address, pendingNonce);
let totalGas = 0n;
for (const step of plan.steps) {
  if ((await ethers.provider.getCode(step.address)) !== "0x") throw new Error(`${step.label} planned address already has code: ${step.address}`);
  if (requiresPriorNftV2Deployments(step.label)) {
    // These constructors validate earlier deterministic CREATE addresses. A
    // standalone mainnet estimate must revert until those CREATEs exist.
    totalGas += NFT_V2_CONTEXT_DEPLOYMENT_GAS_CEILING;
    console.log(`${step.label}: ${step.address} | conservative gas ceiling ${NFT_V2_CONTEXT_DEPLOYMENT_GAS_CEILING} (depends on earlier CREATEs)`);
    continue;
  }
  const factory = await ethers.getContractFactory(step.artifactName, deployer);
  const transaction = await factory.getDeployTransaction(...step.args);
  const estimated = await ethers.provider.estimateGas({ ...transaction, from: address });
  totalGas += estimated;
  console.log(`${step.label}: ${step.address} | estimated gas ${estimated}`);
}
const gasPrice = feeData.gasPrice || 21n * 10n ** 9n;
// Internal configuration grants, definition pools, two maps, and adapter
// consumers are deliberately budgeted in addition to contract creation.
const plannedGas = totalGas * 13n / 10n + 10_000_000n;
const plannedCost = plannedGas * gasPrice;
if (balance < plannedCost + parseEther("1")) {
  throw new Error(`Fund ${address}; deployment buffer requires ${formatEther(plannedCost + parseEther("1"))} RON.`);
}
console.log("Ronin Mainnet NFT V2 deployment signer is ready.");
console.log(`Address: ${address}`);
console.log(`Balance: ${formatEther(balance)} RON`);
console.log(`Pending nonce: ${pendingNonce}`);
console.log(`Fourteen-contract estimated deployment/configuration buffer: ${formatEther(plannedCost)} RON`);
console.log("No transaction was signed or broadcast.");
