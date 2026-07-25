import { network } from "hardhat";
import {
  CONFIG_PATH,
  configHash,
  loadMainnetConfig,
  validateOnchainConfig
} from "./lib/mainnet-config.js";

const { ethers } = await network.create();
const config = loadMainnetConfig();
const result = await validateOnchainConfig(ethers, config);

console.log("Ronin Mainnet contract configuration is valid.");
console.log(`Config: ${CONFIG_PATH}`);
console.log(`Release: ${config.releaseId}`);
console.log(`Config hash: ${configHash(config)}`);
console.log(`Chain: ${result.chainId}`);
console.log(`MATT: ${config.protocol.mattToken}`);
console.log(`Katana MATT/WRON pair: ${result.pair}`);
console.log(`Admin multisig: ${config.roles.contractAdminMultisig}`);
console.log(`Admin Safe threshold: ${result.safeThreshold} of ${result.safeOwners.length}`);
