import { network } from "hardhat";
import {
  ARENA_DEPLOYMENT_PATH,
  RONIN_CHAIN_ID,
  assertArenaManifest,
  loadArenaDeploymentManifest,
  loadArenaMainnetConfig,
  validateArenaOnchainConfig,
  verifyArenaDeploymentState
} from "./lib/arena-mainnet.js";

const { ethers } = await network.create();
const connectedNetwork = await ethers.provider.getNetwork();
if (connectedNetwork.chainId !== RONIN_CHAIN_ID) {
  throw new Error(
    `Connected to chain ${connectedNetwork.chainId}; expected Ronin Mainnet ${RONIN_CHAIN_ID}.`
  );
}

const config = loadArenaMainnetConfig();
const manifest = loadArenaDeploymentManifest();
assertArenaManifest(manifest, config);
if (!["deployed_unverified", "verified_exact"].includes(manifest.status)) {
  throw new Error(
    `Arena deployment manifest has incomplete status ${manifest.status}.`
  );
}

await validateArenaOnchainConfig(ethers, config);
const checked = await verifyArenaDeploymentState(ethers, config, manifest, {
  requireEmptyBalances: false,
  requireEntriesPaused: false
});

console.log("Ronin Mainnet Daily Arena matches the approved production configuration.");
console.log(`MattMineDailyArena: ${checked.address}`);
console.log(`Treasury Safe: ${checked.treasurySafe}`);
console.log(`Emergency pauser: ${checked.emergencyPauser}`);
console.log("Entry price bounds: 25,000 to 1,000,000 MATT.");
console.log("Treasury seed cap: 10,000,000 MATT per day.");
console.log("Player-funded pool: uncapped by the contract.");
console.log("Maximum settlement winners: 10.");
console.log(`Entries paused: ${checked.entriesPaused}.`);
console.log(`Arena MATT balance: ${checked.mattBalance}.`);
console.log(`Arena reserved MATT: ${checked.reservedMatt}.`);
console.log(`Arena next entry number: ${checked.nextEntryNumber}.`);
console.log("The Arena is solvent.");
console.log("All expected roles are present and the temporary deployer has none.");
console.log(`Deployment record: ${ARENA_DEPLOYMENT_PATH}`);
console.log("No transaction was broadcast.");
