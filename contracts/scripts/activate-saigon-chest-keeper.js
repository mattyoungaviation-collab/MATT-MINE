import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatEther, getAddress, Wallet } from "ethers";
import { network } from "hardhat";
import { loadNftSaigonConfig, validateNftSaigonNetwork } from "./lib/nft-saigon.js";

const CONFIRMATION = "ACTIVATE_DEDICATED_MATT_MINE_SAIGON_CHEST_KEEPER";
if (process.env.MATT_MINE_NFT_SAIGON_KEEPER_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_NFT_SAIGON_KEEPER_CONFIRMATION=${CONFIRMATION} after approving the dedicated keeper.`);
}

const deploymentPath = process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_DEPLOYMENT_PATH)
  : resolve("deployments", "nft-saigon.json");
const secretPath = process.env.MATT_MINE_NFT_SAIGON_KEEPER_SECRET_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_KEEPER_SECRET_PATH)
  : resolve("deployments", ".nft-saigon-keeper-secret.json");
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const config = loadNftSaigonConfig();
const { ethers } = await network.create();
await validateNftSaigonNetwork(ethers);

const signers = await ethers.getSigners();
if (signers.length !== 1) throw new Error("Configure exactly one encrypted Saigon admin signer.");
const [admin] = signers;
if (getAddress(await admin.getAddress()) !== config.roles.contractAdmin) {
  throw new Error("The encrypted NUGG signer is not the approved 0xF799 admin.");
}

const randomnessAddress = manifest.contracts?.MattMineSaigonRandomness?.address;
if (!randomnessAddress || await ethers.provider.getCode(randomnessAddress) === "0x") {
  throw new Error("MattMineSaigonRandomness has no deployed code.");
}
const randomness = await ethers.getContractAt("MattMineSaigonRandomness", randomnessAddress, admin);
if (getAddress(await randomness.owner()) !== config.roles.contractAdmin) {
  throw new Error("0xF799 no longer owns Saigon randomness.");
}

let secret;
if (existsSync(secretPath)) {
  secret = JSON.parse(readFileSync(secretPath, "utf8"));
} else {
  const privateKey = `0x${randomBytes(32).toString("hex")}`;
  const wallet = new Wallet(privateKey);
  secret = { address: wallet.address, privateKey, createdAt: new Date().toISOString() };
  writeFileSync(secretPath, `${JSON.stringify(secret, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}
const keeper = new Wallet(secret.privateKey);
if (getAddress(keeper.address) !== getAddress(secret.address)) throw new Error("Keeper secret address mismatch.");

const targetRon = ethers.parseEther("0.05");
const currentRon = await ethers.provider.getBalance(keeper.address);
if (currentRon < targetRon) {
  const funding = await admin.sendTransaction({ to: keeper.address, value: targetRon - currentRon });
  const receipt = await funding.wait();
  if (receipt.status !== 1) throw new Error("Keeper gas funding failed.");
  console.log(`Fund keeper gas: ${funding.hash}`);
}
if (getAddress(await randomness.oracle()) !== getAddress(keeper.address)) {
  const update = await randomness.setOracle(keeper.address);
  const receipt = await update.wait();
  if (receipt.status !== 1) throw new Error("Keeper oracle update failed.");
  console.log(`Set dedicated keeper oracle: ${update.hash}`);
}

console.log(`Keeper address: ${keeper.address}`);
console.log(`Keeper RON: ${formatEther(await ethers.provider.getBalance(keeper.address))}`);
console.log(`Keeper secret file: ${secretPath}`);
console.log("Copy the private key from that local secret file into Render as MATT_MINE_NFT_SAIGON_KEEPER_PRIVATE_KEY.");
