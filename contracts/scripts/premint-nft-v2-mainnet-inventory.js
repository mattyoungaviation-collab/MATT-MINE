import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CONFIG_PATH,
  NFT_V2_ROOT,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";

const CONFIRMATION = "PREMINT_MATT_MINE_MARKET_INVENTORY_ON_RONIN_MAINNET";
if (process.env.MATT_MINE_NFT_V2_MAINNET_PREMINT !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_NFT_V2_MAINNET_PREMINT=${CONFIRMATION}.`);
}
const salesWallet = getAddress(process.env.MATT_MINE_NFT_V2_SALES_WALLET_ADDRESS || "");
const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
const [admin, ...extra] = await ethers.getSigners();
if (!admin || extra.length || getAddress(await admin.getAddress()) !== NFT_V2_ROOT) {
  throw new Error("Inventory minting requires only the encrypted 0xF799 NUGG key.");
}
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
if (manifest.marketInventory?.salesWallet && getAddress(manifest.marketInventory.salesWallet) !== salesWallet) {
  throw new Error(`Partial inventory belongs to ${manifest.marketInventory.salesWallet}; use that same wallet to resume.`);
}

const miner = await ethers.getContractAt("MattV2Miner", manifest.contracts.Miner.address, admin);
if (!(await miner.paused())) throw new Error("Miner must be paused when the controlled inventory procedure starts.");
if (await miner.MAX_SUPPLY() !== 1_000n) throw new Error("Miner maximum supply is not 1,000.");
if (!(await miner.hasRole(await miner.MINTER_ROLE(), NFT_V2_ROOT))) throw new Error("0xF799 no longer has the temporary Miner mint role.");
let nextTokenId = await miner.nextTokenId();
if (nextTokenId < 1n || nextTokenId > 1_001n) throw new Error("Miner supply is outside the approved range.");
if (await miner.balanceOf(salesWallet) !== nextTokenId - 1n) throw new Error("The sales wallet does not own every previously minted Miner.");

manifest.marketInventory ??= {
  mode: "preminted_secondary_marketplace",
  salesWallet,
  targetQuantity: 1_000,
  transactions: []
};
manifest.marketInventory.salesWallet = salesWallet;
manifest.marketInventory.targetQuantity = 1_000;
manifest.marketInventory.mintedQuantity = Number(nextTokenId - 1n);
manifest.marketInventory.startedAt ??= new Date().toISOString();
manifest.status = nextTokenId === 1_001n ? "market_inventory_minted_paused" : "market_inventory_minting";
save();

if (nextTokenId === 1_001n) {
  console.log(`All 1,000 Miners are already held by ${salesWallet}. Nothing was broadcast.`);
  process.exitCode = 0;
} else {
  let mintError;
  try {
    await send("Unpause Miner for controlled inventory mint", () => miner.unpauseMinting());
    while (nextTokenId <= 1_000n) {
      const remaining = Number(1_001n - nextTokenId);
      const { quantity, gasLimit } = await safeBatchParameters(Math.min(100, remaining));
      const firstTokenId = nextTokenId;
      await send(
        `Mint Miners ${firstTokenId}-${firstTokenId + BigInt(quantity) - 1n} to marketplace inventory`,
        () => miner["mint(address,uint256)"](salesWallet, quantity, { gasLimit })
      );
      nextTokenId = await miner.nextTokenId();
      manifest.marketInventory.mintedQuantity = Number(nextTokenId - 1n);
      save();
    }
  } catch (error) {
    mintError = error;
  }

  let pauseError;
  try {
    if (!(await miner.paused())) await send("Re-pause Miner after controlled inventory mint", () => miner.pauseMinting());
  } catch (error) {
    pauseError = error;
  }
  if (pauseError) {
    manifest.status = "market_inventory_emergency_unpaused";
    manifest.marketInventory.lastError = pauseError.shortMessage || pauseError.message;
    manifest.updatedAt = new Date().toISOString();
    save();
    throw new Error(`URGENT: inventory minting stopped and Miner could not be re-paused. ${manifest.marketInventory.lastError}`);
  }
  if (mintError) {
    nextTokenId = await miner.nextTokenId();
    manifest.status = "market_inventory_partial_paused";
    manifest.marketInventory.mintedQuantity = Number(nextTokenId - 1n);
    manifest.marketInventory.lastError = mintError.shortMessage || mintError.message;
    manifest.updatedAt = new Date().toISOString();
    save();
    throw new Error(`Inventory mint stopped safely after ${nextTokenId - 1n}/1000. Re-run the same secure script to resume. ${manifest.marketInventory.lastError}`);
  }

  nextTokenId = await miner.nextTokenId();
  if (nextTokenId !== 1_001n || await miner.balanceOf(salesWallet) !== 1_000n) {
    throw new Error("Final marketplace inventory ownership check failed.");
  }
  if (getAddress(await miner.ownerOf(1n)) !== salesWallet || getAddress(await miner.ownerOf(1_000n)) !== salesWallet) {
    throw new Error("Final marketplace inventory ownership sample failed.");
  }
  manifest.status = "market_inventory_minted_paused";
  manifest.marketInventory.mintedQuantity = 1_000;
  manifest.marketInventory.completedAt = new Date().toISOString();
  delete manifest.marketInventory.lastError;
  manifest.updatedAt = manifest.marketInventory.completedAt;
  save();
  console.log(`Marketplace inventory complete: all 1,000 Miners belong to ${salesWallet}.`);
  console.log("Miner minting is re-paused. Equipment and gameplay contracts were untouched.");
}

async function safeBatchParameters(initialQuantity) {
  const block = await ethers.provider.getBlock("latest");
  const maximumGas = block.gasLimit * 7n / 10n;
  let quantity = initialQuantity;
  while (quantity >= 1) {
    try {
      const estimate = await miner["mint(address,uint256)"].estimateGas(salesWallet, quantity);
      const gasLimit = estimate * 120n / 100n;
      if (gasLimit <= maximumGas) return { quantity, gasLimit };
    } catch (error) {
      if (quantity === 1) throw error;
    }
    quantity = Math.floor(quantity / 2);
  }
  throw new Error("Unable to find a safe Miner mint batch size.");
}

async function send(label, factory) {
  const tx = await factory();
  const receipt = await tx.wait();
  if (receipt.status !== 1) throw new Error(`${label} failed.`);
  manifest.marketInventory.transactions.push({ label, hash: tx.hash, blockNumber: receipt.blockNumber });
  manifest.updatedAt = new Date().toISOString();
  save();
  console.log(`${label}: ${tx.hash}`);
}

function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
