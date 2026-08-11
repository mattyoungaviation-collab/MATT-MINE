import { network } from "hardhat";
import { loadNftSaigonConfig, validateNftSaigonNetwork } from "./lib/nft-saigon.js";

const { ethers } = await network.create();
const config = loadNftSaigonConfig();
await validateNftSaigonNetwork(ethers);

console.log("MATT Mine NFT v1 Saigon configuration is valid.");
console.log(`Chain: ${config.chainId}`);
console.log(`Full-control admin: ${config.roles.contractAdmin}`);
console.log(`Test payment vault: ${config.treasury.vault}`);
console.log(`Test randomness oracle: ${config.roles.randomnessOracle}`);
console.log("Test MATT, Crystals, and controlled randomness will be deployed with the suite.");
console.log("No transaction was broadcast.");
