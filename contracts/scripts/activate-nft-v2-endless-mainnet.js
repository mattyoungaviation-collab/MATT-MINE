import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, parseEther } from "ethers";
import { network } from "hardhat";
import {
  ENDLESS_MAINNET_CHAIN_ID,
  loadActivatedNftV2Base,
  loadEndlessMainnetConfig
} from "./lib/nft-v2-endless-mainnet.js";

const CONFIRMATION = "ACTIVATE_MATT_MINE_ENDLESS_ON_RONIN_MAINNET";
if (process.env.MATT_MINE_ENDLESS_MAINNET_ACTIVATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_ENDLESS_MAINNET_ACTIVATION=${CONFIRMATION} after the live-state check passes.`);
}
const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== ENDLESS_MAINNET_CHAIN_ID) throw new Error("Endless activation requires Ronin Mainnet chain 2020.");
const config = loadEndlessMainnetConfig();
loadActivatedNftV2Base(config);
const [admin, ...extra] = await ethers.getSigners();
if (!admin || extra.length || getAddress(await admin.getAddress()) !== config.roles.rootAdmin) {
  throw new Error("Endless activation requires only the encrypted Root admin key.");
}
const deploymentPath = process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_ENDLESS_MAINNET_DEPLOYMENT_PATH)
  : resolve(dirname(config.configPath), "..", "deployments", "nft-v2-endless-ronin.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const manifest = JSON.parse(readFileSync(deploymentPath, "utf8"));
if (manifest.status !== "deployed_configured_paused_requires_activation") throw new Error("Endless is not in the configured-paused activation state.");
const proxy = getAddress(manifest.contracts?.EndlessSettlementProxy?.address || "");
const endless = await ethers.getContractAt("MattV2EndlessSettlement", proxy, admin);
if (!(await endless.paused())) throw new Error("Endless is already unpaused.");
if (getAddress(await endless.rewardSigner()) !== config.roles.rewardSigner) throw new Error("Endless Reward Signer mismatch.");
if (await endless.hasRole(await endless.OPERATOR_ROLE(), config.roles.rewardSigner)) throw new Error("Reward Signer must not have the operator role.");
if (await ethers.provider.getBalance(config.roles.gameOperator) < parseEther("0.05")) throw new Error("Endless Game Operator needs at least 0.05 RON.");
for (const [economyVersion, version] of Object.entries(config.versions)) {
  const state = await endless.versions(version.versionId);
  if (!state.approved || state.retired) throw new Error(`${economyVersion} is unavailable.`);
}
const transaction = await endless.unpause();
const receipt = await transaction.wait();
if (receipt.status !== 1) throw new Error("Endless activation failed.");
manifest.status = "activated";
manifest.activatedAt = new Date().toISOString();
manifest.activationTransaction = { hash: transaction.hash, blockNumber: receipt.blockNumber };
save();
console.log(`Endless reward settlement activated at ${proxy}.`);

function save() {
  const temporary = `${deploymentPath}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(temporary, deploymentPath);
}
