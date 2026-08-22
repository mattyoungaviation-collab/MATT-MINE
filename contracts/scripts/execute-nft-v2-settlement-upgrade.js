import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import { network } from "hardhat";
import { NFT_V2_MAINNET_CHAIN_ID, NFT_V2_ROOT } from "./lib/nft-v2-mainnet.js";

const CONFIRMATION = "EXECUTE_SETTLEMENT_XP_UPGRADE";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
if (process.env.MATT_MINE_SETTLEMENT_UPGRADE_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_SETTLEMENT_UPGRADE_CONFIRMATION=${CONFIRMATION}.`);
}

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== NFT_V2_MAINNET_CHAIN_ID) throw new Error("Wrong network; expected Ronin Mainnet 2020.");
const [signer, ...extra] = await ethers.getSigners();
if (!signer || extra.length) throw new Error("Configure exactly one encrypted NUGG deployment signer.");
if (getAddress(await signer.getAddress()) !== NFT_V2_ROOT) throw new Error(`Signer must be ${NFT_V2_ROOT}.`);

const upgradePath = resolve("deployments", "nft-v2-settlement-upgrade.json");
if (!existsSync(upgradePath)) throw new Error("Run the Settlement upgrade scheduling script first.");
const upgrade = JSON.parse(readFileSync(upgradePath, "utf8"));
const timelock = await ethers.getContractAt("MattV2UpgradeTimelock", upgrade.timelock, signer);
const current = await currentImplementation(upgrade.proxy);
if (current === getAddress(upgrade.implementation)) {
  console.log("Settlement upgrade was already executed.");
  process.exit(0);
}
if (current !== getAddress(upgrade.previousImplementation)) throw new Error(`Unexpected current implementation ${current}.`);
const readyAt = await timelock.readyAt(upgrade.operationId);
if (readyAt === 0n) throw new Error("The saved upgrade is not scheduled on-chain.");
const now = BigInt(Math.floor(Date.now() / 1000));
if (now < readyAt) throw new Error(`Upgrade is not ready. Try again after ${new Date(Number(readyAt) * 1000).toISOString()}.`);

const transaction = await timelock.execute(upgrade.proxy, upgrade.implementation, upgrade.data, upgrade.salt);
const receipt = await transaction.wait();
if (receipt.status !== 1) throw new Error("Settlement upgrade execution failed.");
if (await currentImplementation(upgrade.proxy) !== getAddress(upgrade.implementation)) throw new Error("Proxy implementation did not change.");
const settlement = await ethers.getContractAt("MattV2GameSettlement", upgrade.proxy);
const deployment = JSON.parse(readFileSync(resolve("deployments", "nft-v2-ronin.json"), "utf8"));
for (const [mode, versionId] of Object.entries(deployment.mapVersions || {})) {
  const xp = await settlement.phaseXpForMap(versionId);
  console.log(`${mode} phase XP: ${xp.map(Number).join(", ")}`);
}
upgrade.executeTransactionHash = transaction.hash;
upgrade.executeBlock = receipt.blockNumber;
upgrade.executedAt = new Date().toISOString();
upgrade.status = "executed";
save(upgradePath, upgrade);
console.log(`Settlement upgraded: ${transaction.hash}`);
console.log("Future Settlement upgrades can be authorized directly by the Root/default admin.");

async function currentImplementation(proxy) {
  const value = await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT);
  return getAddress(`0x${value.slice(-40)}`);
}
function save(path, value) {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
