import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, formatUnits, getAddress, parseEther, parseUnits } from "ethers";
import { network } from "hardhat";
import { validateNftSaigonNetwork } from "./lib/nft-saigon.js";

const player = getAddress(process.env.MATT_MINE_NFT_SAIGON_TEST_PLAYER || "");
const deploymentPath = process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH)
  : resolve("deployments", "nft-saigon.json");
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const { ethers } = await network.create();
await validateNftSaigonNetwork(ethers);

if (manifest.status !== "rehearsal_live") throw new Error(`Manifest status is ${manifest.status}, not rehearsal_live.`);
if (getAddress(manifest.rehearsal?.testPlayer) !== player) throw new Error("Manifest test player does not match.");
const contract = async (name) => ethers.getContractAt(name, manifest.contracts[name].address);
const matt = await contract("MattMineSaigonMatt");
const miner = await contract("MattMiner");
const loadout = await contract("MattLoadout");
const chest = await contract("MattChest");
const settlement = await contract("MattGameSettlement");
const redemption = await contract("MattCrystalRedemption");

if (getAddress(await miner.ownerOf(1n)) !== player) throw new Error("Miner #1 is not owned by the test player.");
if (await matt.balanceOf(player) < parseUnits("10000", 18)) throw new Error("Test player has less than 10,000 MATT.");
if (await ethers.provider.getBalance(player) < parseEther("0.5")) throw new Error("Test player has less than 0.5 RON.");
for (const [label, instance] of Object.entries({ loadout, chest, settlement, redemption })) {
  if (await instance.paused()) throw new Error(`${label} is still paused.`);
}

console.log("Saigon NFT rehearsal activation verified on-chain.");
console.log(`Player: ${player}`);
console.log(`Miner #1 owner: ${await miner.ownerOf(1n)}`);
console.log(`Test MATT: ${formatUnits(await matt.balanceOf(player), 18)}`);
console.log(`Test RON: ${formatEther(await ethers.provider.getBalance(player))}`);
console.log("Loadout, Chest, Settlement, and Redemption are live on Saigon.");
