import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, parseEther } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CONFIG_PATH,
  NFT_V2_ROOT,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";

const salesWallet = addressFromEnvironment("MATT_MINE_NFT_V2_SALES_WALLET_ADDRESS");
const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const deploymentPath = process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(NFT_V2_MAINNET_CONFIG_PATH), "..", "deployments", "nft-v2-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
const allowedStatuses = new Set([
  "verified_paused",
  "market_inventory_minting",
  "market_inventory_partial_paused",
  "market_inventory_minted_paused"
]);
if (!allowedStatuses.has(manifest.status)) throw new Error(`Inventory mint cannot continue from status ${manifest.status}.`);
validateSalesWallet(salesWallet, config, manifest);
if ((await ethers.provider.getCode(salesWallet)) !== "0x") {
  throw new Error("The marketplace inventory wallet must be a normal EOA, not a contract or Safe.");
}

const at = (artifact, label) => ethers.getContractAt(artifact, manifest.contracts[label].address);
const miner = await at("MattV2Miner", "Miner");
const equipment = await at("MattV2Equipment", "Equipment");
const modules = [
  miner,
  equipment,
  await at("MattV2Loadout", "Loadout"),
  await at("MattV2CrystalBank", "CrystalBankProxy"),
  await at("MattV2PassiveRewards", "PassiveRewardsProxy"),
  await at("MattV2GameSettlement", "GameSettlementProxy"),
  await at("MattV2Chest", "ChestProxy")
];
for (const contract of modules) if (!(await contract.paused())) throw new Error(`${contract.target} must remain paused before inventory minting.`);
if (await miner.MAX_SUPPLY() !== 1_000n) throw new Error("Miner maximum supply is not 1,000.");
if (await equipment.nextTokenId() !== 1n) throw new Error("Equipment inventory must remain empty.");
if (!(await miner.hasRole(await miner.MINTER_ROLE(), NFT_V2_ROOT))) throw new Error("0xF799 no longer has the temporary Miner mint role.");
if (!(await miner.hasRole(await miner.DEFAULT_ADMIN_ROLE(), NFT_V2_ROOT))) throw new Error("0xF799 is not the Miner default admin.");

const nextTokenId = await miner.nextTokenId();
if (nextTokenId < 1n || nextTokenId > 1_001n) throw new Error("Miner supply is outside the approved range.");
const alreadyMinted = nextTokenId - 1n;
if (manifest.marketInventory?.salesWallet && getAddress(manifest.marketInventory.salesWallet) !== salesWallet) {
  throw new Error(`Partial inventory belongs to ${manifest.marketInventory.salesWallet}; use that same wallet to resume.`);
}
if (await miner.balanceOf(salesWallet) !== alreadyMinted) {
  throw new Error("The sales wallet balance does not equal the complete minted supply.");
}
if (alreadyMinted > 0n) {
  if (getAddress(await miner.ownerOf(1n)) !== salesWallet || getAddress(await miner.ownerOf(alreadyMinted)) !== salesWallet) {
    throw new Error("Inventory ownership sample mismatch.");
  }
}
if (await ethers.provider.getBalance(NFT_V2_ROOT) < parseEther("1")) throw new Error("0xF799 needs at least 1 RON for inventory transactions.");

console.log("NFT V2 marketplace inventory preflight passed without broadcasting a transaction.");
console.log(`Sales wallet: ${salesWallet}`);
console.log(`Already minted: ${alreadyMinted}/1000`);
console.log(`Remaining: ${1_000n - alreadyMinted}`);
console.log("All seven gameplay modules remain paused and the existing inventory can be resumed safely.");

function addressFromEnvironment(name) {
  try { return getAddress(process.env[name] || ""); }
  catch { throw new Error(`Set ${name} to the dedicated marketplace inventory EOA.`); }
}

function validateSalesWallet(wallet, loadedConfig, loadedManifest) {
  const forbidden = new Set([
    NFT_V2_ROOT,
    ...Object.values(loadedConfig.activationRoles),
    ...Object.values(loadedConfig.protocol).filter((value) => typeof value === "string" && /^0x[0-9a-f]{40}$/i.test(value)),
    ...Object.values(loadedManifest.contracts).map((record) => getAddress(record.address))
  ]);
  if (forbidden.has(wallet)) throw new Error("Use a dedicated sales EOA, not an admin, operator, signer, keeper, token, or NFT-suite contract address.");
}
