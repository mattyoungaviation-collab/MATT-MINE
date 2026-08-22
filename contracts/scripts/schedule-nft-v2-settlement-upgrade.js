import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { getAddress, id } from "ethers";
import { network } from "hardhat";
import { NFT_V2_MAINNET_CHAIN_ID, NFT_V2_ROOT } from "./lib/nft-v2-mainnet.js";

const CONFIRMATION = "SCHEDULE_SETTLEMENT_XP_UPGRADE";
const IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SALT = id("MATT_MINE_SETTLEMENT_XP_DIRECT_ADMIN_V1");
if (process.env.MATT_MINE_SETTLEMENT_UPGRADE_CONFIRMATION !== CONFIRMATION) {
  throw new Error(`Set MATT_MINE_SETTLEMENT_UPGRADE_CONFIRMATION=${CONFIRMATION}.`);
}

const { ethers } = await network.create();
if ((await ethers.provider.getNetwork()).chainId !== NFT_V2_MAINNET_CHAIN_ID) throw new Error("Wrong network; expected Ronin Mainnet 2020.");
const [signer, ...extra] = await ethers.getSigners();
if (!signer || extra.length) throw new Error("Configure exactly one encrypted NUGG deployment signer.");
if (getAddress(await signer.getAddress()) !== NFT_V2_ROOT) throw new Error(`Signer must be ${NFT_V2_ROOT}.`);

const deploymentPath = resolve("deployments", "nft-v2-ronin.json");
const upgradePath = resolve("deployments", "nft-v2-settlement-upgrade.json");
if (!existsSync(deploymentPath)) throw new Error(`Missing ${deploymentPath}.`);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const timelockAddress = getAddress(deployment.contracts?.UpgradeTimelock?.address);
const proxyAddress = getAddress(deployment.contracts?.GameSettlementProxy?.address);
const oldImplementation = getAddress(deployment.contracts?.GameSettlementImplementation?.address);
const timelock = await ethers.getContractAt("MattV2UpgradeTimelock", timelockAddress, signer);
if (getAddress(await timelock.owner()) !== NFT_V2_ROOT) throw new Error("0xF799 is not the Upgrade Timelock owner.");

let upgrade = existsSync(upgradePath) ? JSON.parse(readFileSync(upgradePath, "utf8")) : null;
if (!upgrade) {
  if (await currentImplementation(proxyAddress) !== oldImplementation) throw new Error("Settlement proxy implementation differs from the deployment manifest.");
  const factory = await ethers.getContractFactory("MattV2GameSettlement", signer);
  const implementation = await factory.deploy(timelockAddress);
  const transaction = implementation.deploymentTransaction();
  upgrade = {
    schemaVersion: 1,
    proxy: proxyAddress,
    previousImplementation: oldImplementation,
    implementation: getAddress(implementation.target),
    deploymentTransactionHash: transaction.hash,
    timelock: timelockAddress,
    salt: SALT,
    data: "0x",
    status: "implementation_broadcast",
    createdAt: new Date().toISOString()
  };
  save(upgradePath, upgrade);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error("Settlement implementation deployment failed.");
  upgrade.deploymentBlock = receipt.blockNumber;
  upgrade.status = "implementation_deployed";
  save(upgradePath, upgrade);
  console.log(`New Settlement implementation: ${upgrade.implementation}`);
}

if ((await ethers.provider.getCode(upgrade.implementation)) === "0x") throw new Error("Saved implementation has no code.");
const implementation = await ethers.getContractAt("MattV2GameSettlement", upgrade.implementation);
if (getAddress(await implementation.UPGRADE_TIMELOCK()) !== timelockAddress) throw new Error("Implementation timelock mismatch.");
if (await currentImplementation(proxyAddress) === getAddress(upgrade.implementation)) {
  upgrade.status = "executed";
  save(upgradePath, upgrade);
  console.log("Settlement upgrade was already executed.");
  process.exit(0);
}

const operationId = await timelock.operationId(proxyAddress, upgrade.implementation, upgrade.data, upgrade.salt);
let readyAt = await timelock.readyAt(operationId);
if (readyAt === 0n) {
  const transaction = await timelock.schedule(proxyAddress, upgrade.implementation, upgrade.data, upgrade.salt);
  const receipt = await transaction.wait();
  if (receipt.status !== 1) throw new Error("Settlement upgrade scheduling failed.");
  upgrade.scheduleTransactionHash = transaction.hash;
  upgrade.scheduleBlock = receipt.blockNumber;
  readyAt = await timelock.readyAt(operationId);
}
upgrade.operationId = operationId;
upgrade.readyAt = Number(readyAt);
upgrade.readyAtUtc = new Date(Number(readyAt) * 1000).toISOString();
upgrade.status = "scheduled";
save(upgradePath, upgrade);
console.log(`Upgrade operation: ${operationId}`);
console.log(`Ready at: ${upgrade.readyAtUtc}`);
console.log(`Saved checkpoint: ${upgradePath}`);

async function currentImplementation(proxy) {
  const value = await ethers.provider.getStorage(proxy, IMPLEMENTATION_SLOT);
  return getAddress(`0x${value.slice(-40)}`);
}
function save(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, path);
}
