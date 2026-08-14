import { formatEther, formatUnits, getAddress, getCreateAddress } from "ethers";
import { network } from "hardhat";
import {
  RONIN_CHAIN_ID,
  loadNftMainnetConfig,
  validateNftOnchainConfig
} from "./lib/nft-mainnet.js";

const expectedRaw = process.env.MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS;
if (!expectedRaw) throw new Error("Set MATT_MINE_NFT_EXPECTED_DEPLOYER_ADDRESS to the approved temporary deployer.");
const expectedDeployer = getAddress(expectedRaw);

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
for (const [label, address] of Object.entries({ ...config.roles, vault: config.treasury.vault })) {
  if (getAddress(address) === deployerAddress) throw new Error(`Temporary deployer cannot also be ${label}.`);
}

const networkInfo = await ethers.provider.getNetwork();
if (networkInfo.chainId !== RONIN_CHAIN_ID) throw new Error(`Connected to chain ${networkInfo.chainId}; expected ${RONIN_CHAIN_ID}.`);
const [balance, pendingNonce, feeData] = await Promise.all([
  ethers.provider.getBalance(deployerAddress),
  ethers.provider.getTransactionCount(deployerAddress, "pending"),
  ethers.provider.getFeeData()
]);
if (feeData.gasPrice === null) throw new Error("Ronin RPC did not return a gas price.");

const addresses = Object.freeze({
  miner: getCreateAddress({ from: deployerAddress, nonce: pendingNonce }),
  equipment: getCreateAddress({ from: deployerAddress, nonce: pendingNonce + 1 }),
  vrfAdapter: getCreateAddress({ from: deployerAddress, nonce: pendingNonce + 2 }),
  loadout: getCreateAddress({ from: deployerAddress, nonce: pendingNonce + 3 }),
  chest: getCreateAddress({ from: deployerAddress, nonce: pendingNonce + 4 }),
  settlement: getCreateAddress({ from: deployerAddress, nonce: pendingNonce + 5 }),
  redemption: getCreateAddress({ from: deployerAddress, nonce: pendingNonce + 6 })
});

const deployments = [
  ["MattMiner", [config.roles.contractAdmin, config.metadata.minerBaseUri, config.metadata.minerContractUri]],
  ["MattEquipment", [config.roles.contractAdmin, config.metadata.equipmentBaseUri, config.metadata.equipmentContractUri]],
  ["MattMineVRFV25Adapter", [
    config.protocol.vrfCoordinator,
    config.protocol.vrfSubscriptionId,
    config.protocol.vrfKeyHash,
    config.roles.contractAdmin,
    config.vrf.requestConfirmations,
    config.vrf.coordinatorCallbackGasLimit,
    config.vrf.consumerCallbackGasLimit
  ]],
  ["MattLoadout", [
    config.roles.contractAdmin,
    addresses.miner,
    addresses.equipment,
    config.protocol.mattToken,
    config.treasury.vault,
    config.economy.repairPriceMattWei,
    config.roles.emergencyPauser
  ]],
  ["MattChest", [
    config.roles.contractAdmin,
    config.protocol.mattToken,
    addresses.equipment,
    addresses.vrfAdapter,
    config.treasury.vault,
    config.roles.emergencyPauser
  ]],
  ["MattGameSettlement", [
    config.roles.contractAdmin,
    addresses.miner,
    addresses.loadout,
    config.roles.gameSigner,
    config.roles.gameOperator,
    config.roles.emergencyPauser
  ]],
  ["MattCrystalRedemption", [
    config.roles.contractAdmin,
    config.protocol.crystalToken,
    config.roles.redemptionSigner,
    config.economy.minimumCrystalWithdrawalWei,
    config.economy.maximumDailyCrystalWithdrawalWei,
    config.roles.emergencyPauser
  ]]
];

let totalGasWithHeadroom = 0n;
for (let index = 0; index < deployments.length; index += 1) {
  const [name, constructorArgs] = deployments[index];
  const factory = await ethers.getContractFactory(name, deployer);
  const transaction = await factory.getDeployTransaction(...constructorArgs);
  const estimatedGas = await ethers.provider.estimateGas({ ...transaction, from: deployerAddress });
  const gasWithHeadroom = (estimatedGas * 120n + 99n) / 100n;
  totalGasWithHeadroom += gasWithHeadroom;
  console.log(`${name}: ${Object.values(addresses)[index]} | estimated gas ${estimatedGas} | planned ${gasWithHeadroom}`);
}

const estimatedCost = totalGasWithHeadroom * feeData.gasPrice;
const requiredBalance = estimatedCost * 3n;
if (balance < requiredBalance) {
  throw new Error(`NFT deployer has ${formatEther(balance)} RON; at least ${formatEther(requiredBalance)} RON is required for the 3x gas buffer.`);
}

console.log("Ronin Mainnet NFT deployment signer is ready.");
console.log(`Address: ${deployerAddress}`);
console.log(`Balance: ${formatEther(balance)} RON`);
console.log(`Pending nonce: ${pendingNonce}`);
console.log(`Gas price: ${formatUnits(feeData.gasPrice, "gwei")} gwei`);
console.log(`Estimated seven-contract deployment cost: ${formatEther(estimatedCost)} RON`);
console.log(`Required 3x gas buffer: ${formatEther(requiredBalance)} RON`);
console.log("No transaction was broadcast.");
