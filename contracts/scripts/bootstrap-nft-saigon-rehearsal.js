import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, formatUnits, getAddress, parseEther, parseUnits } from "ethers";
import { network } from "hardhat";
import { loadNftSaigonConfig, validateNftSaigonNetwork } from "./lib/nft-saigon.js";

const CONFIRMATION = "ACTIVATE_MATT_MINE_NFT_V1_SAIGON_REHEARSAL";
if (process.env.MATT_MINE_NFT_SAIGON_REHEARSAL_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_NFT_SAIGON_REHEARSAL_CONFIRMATION=${CONFIRMATION} after approving the test player.`);
}
const player = getAddress(process.env.MATT_MINE_NFT_SAIGON_TEST_PLAYER || "");
const targetMattBalance = parseUnits("10000", 18);
const targetRonBalance = parseEther("0.5");
const deploymentPath = process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH)
  : resolve("deployments", "nft-saigon.json");
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const config = loadNftSaigonConfig();
const { ethers } = await network.create();
await validateNftSaigonNetwork(ethers);

if (await ethers.provider.getCode(player) !== "0x") throw new Error("The Saigon test player must be an EOA.");
if (!String(manifest.status).startsWith("configured_") && manifest.status !== "rehearsal_live") {
  throw new Error(`The deployment manifest is not configured for rehearsal: ${manifest.status}`);
}
const signers = await ethers.getSigners();
if (signers.length !== 1) throw new Error("Configure exactly one encrypted Saigon admin signer.");
const [admin] = signers;
if (getAddress(await admin.getAddress()) !== config.roles.contractAdmin) {
  throw new Error("The encrypted NUGG signer is not the approved 0xF799 admin.");
}

const contract = async (name) => {
  const address = manifest.contracts?.[name]?.address;
  if (!address || await ethers.provider.getCode(address) === "0x") throw new Error(`${name} has no deployed code.`);
  return ethers.getContractAt(name, address, admin);
};
const matt = await contract("MattMineSaigonMatt");
const miner = await contract("MattMiner");
const loadout = await contract("MattLoadout");
const chest = await contract("MattChest");
const settlement = await contract("MattGameSettlement");
const redemption = await contract("MattCrystalRedemption");
const transactions = [];

const currentRonBalance = await ethers.provider.getBalance(player);
if (currentRonBalance < targetRonBalance) {
  await send("Fund test-player gas", () => admin.sendTransaction({
    to: player,
    value: targetRonBalance - currentRonBalance
  }));
}

const currentMattBalance = await matt.balanceOf(player);
if (currentMattBalance < targetMattBalance) {
  await send("Fund test-player MATT", () => matt.transfer(player, targetMattBalance - currentMattBalance));
}

const nextMinerId = await miner.nextTokenId();
if (nextMinerId === 1n) {
  await send("Mint Miner #1 to test player", () => miner.mint(player));
} else if (getAddress(await miner.ownerOf(1n)) !== player) {
  throw new Error(`Miner #1 already belongs to ${await miner.ownerOf(1n)}, not the approved test player.`);
}

for (const [label, instance] of Object.entries({ loadout, chest, settlement, redemption })) {
  if (await instance.paused()) await send(`Unpause ${label}`, () => instance.unpause());
}

if (getAddress(await miner.ownerOf(1n)) !== player) throw new Error("Miner #1 ownership check failed.");
if (await matt.balanceOf(player) < targetMattBalance) throw new Error("Test MATT funding check failed.");
if (await ethers.provider.getBalance(player) < targetRonBalance) throw new Error("Test RON funding check failed.");
for (const [label, instance] of Object.entries({ loadout, chest, settlement, redemption })) {
  if (await instance.paused()) throw new Error(`${label} did not unpause.`);
}

manifest.status = "rehearsal_live";
manifest.rehearsal = {
  testPlayer: player,
  minerId: 1,
  targetMattBalance: targetMattBalance.toString(),
  targetRonBalance: targetRonBalance.toString(),
  activatedAt: new Date().toISOString(),
  transactions
};
manifest.requiredPostDeploymentActions = [
  "Connect the test-player wallet to Saigon chain 202601",
  "Exercise backpack, chest, equip, rendering, extraction, death, repair, transfer, and Crystal redemption flows",
  "Record every transaction and observed render before preparing mainnet"
];
const temporaryPath = `${deploymentPath}.tmp`;
writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
renameSync(temporaryPath, deploymentPath);

console.log("Saigon NFT rehearsal is live.");
console.log(`Test player: ${player}`);
console.log(`Miner: #1`);
console.log(`MATT balance: ${formatUnits(await matt.balanceOf(player), 18)}`);
console.log(`RON balance: ${formatEther(await ethers.provider.getBalance(player))}`);

async function send(label, operation) {
  const transaction = await operation();
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error(`${label} transaction failed.`);
  transactions.push({ label, transactionHash: transaction.hash, blockNumber: receipt.blockNumber });
  console.log(`${label}: ${transaction.hash}`);
}
