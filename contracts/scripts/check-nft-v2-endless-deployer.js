import { getAddress, getCreateAddress, parseEther } from "ethers";
import hre, { network } from "hardhat";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  loadActivatedNftV2Base,
  loadEndlessMainnetConfig
} from "./lib/nft-v2-endless-mainnet.js";

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) throw new Error("Endless preflight requires Ronin Mainnet chain 2020.");
const config = loadEndlessMainnetConfig();
const base = loadActivatedNftV2Base(config);
const deployerAddress = config.roles.rootAdmin;
const latest = await ethers.provider.getTransactionCount(deployerAddress, "latest");
const pending = await ethers.provider.getTransactionCount(deployerAddress, "pending");
if (latest !== pending) throw new Error("The Endless deployment wallet has pending transactions.");
const balance = await ethers.provider.getBalance(deployerAddress);
if (balance < parseEther("1")) throw new Error("The Root deployment wallet needs at least 1 RON for the deployment packet.");
if (await ethers.provider.getBalance(config.roles.gameOperator) < parseEther("0.05")) throw new Error("The Endless Game Operator needs at least 0.05 RON.");

for (const [key, address] of Object.entries(base.contracts)) {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`Base ${key} has no Ronin contract code.`);
}
for (const [artifact, address] of [
  ["MattV2Miner", base.contracts.miner],
  ["MattV2Loadout", base.contracts.loadout],
  ["MattV2CrystalBank", base.contracts.crystalBank],
  ["MattV2PassiveRewards", base.contracts.passiveRewards]
]) {
  const contract = await ethers.getContractAt(artifact, address);
  if (getAddress(await contract.defaultAdmin()) !== config.roles.rootAdmin) throw new Error(`${artifact} Root admin mismatch.`);
}

const artifact = await hre.artifacts.readArtifact("MattV2EndlessSettlement");
const runtimeBytes = (artifact.deployedBytecode.length - 2) / 2;
if (runtimeBytes > 24_576) throw new Error(`Endless runtime is ${runtimeBytes} bytes and cannot deploy on Ronin.`);
const implementation = getCreateAddress({ from: deployerAddress, nonce: BigInt(pending) });
const proxy = getCreateAddress({ from: deployerAddress, nonce: BigInt(pending) + 1n });
for (const [label, address] of [["implementation", implementation], ["proxy", proxy]]) {
  if ((await ethers.provider.getCode(address)) !== "0x") throw new Error(`Predicted Endless ${label} address is already occupied.`);
}

console.log("Endless Ronin deployment preflight passed. No transaction was broadcast.");
console.log(`Required deployer: ${deployerAddress}`);
console.log(`Balance: ${ethers.formatEther(balance)} RON`);
console.log(`Starting nonce: ${pending}`);
console.log(`Runtime bytecode: ${runtimeBytes} / 24576 bytes`);
console.log(`Predicted implementation: ${implementation}`);
console.log(`Predicted proxy: ${proxy}`);
for (const [economyVersion, version] of Object.entries(config.versions)) {
  console.log(`${economyVersion}: ${version.versionId}`);
}
