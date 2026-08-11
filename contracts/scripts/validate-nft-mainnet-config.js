import { network } from "hardhat";
import { loadNftMainnetConfig, validateNftOnchainConfig } from "./lib/nft-mainnet.js";

const { ethers } = await network.create();
const config = loadNftMainnetConfig();
await validateNftOnchainConfig(ethers, config);

console.log("MATT Mine NFT v1 Ronin configuration is locally and on-chain valid.");
console.log(`Full-control admin: ${config.roles.contractAdmin}`);
console.log(`Payment vault: ${config.treasury.vault}`);
console.log(`Emergency pauser: ${config.roles.emergencyPauser}`);
console.log(`MATT: ${config.protocol.mattToken}`);
console.log(`Crystals: ${config.protocol.crystalToken}`);
console.log(`VRF coordinator: ${config.protocol.vrfCoordinator}`);
console.log("No transaction was broadcast.");
