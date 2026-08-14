import { formatUnits, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_MAINNET_CONFIRMATION,
  jsonSafe,
  loadNftV2MainnetConfig,
  validateNftV2MainnetNetwork
} from "./lib/nft-v2-mainnet.js";

const { ethers } = await network.create();
const config = loadNftV2MainnetConfig();
await validateNftV2MainnetNetwork(ethers, config);
console.log("MATT Mine NFT V2 Ronin Mainnet configuration is structurally and on-chain valid.");
console.log(`Config hash: ${keccak256(toUtf8Bytes(JSON.stringify(jsonSafe(config))))}`);
console.log(`Bootstrap root and all initial roles: ${config.roles.rootAdmin}`);
for (const [mode, map] of Object.entries(config.maps)) {
  console.log(`${mode}: ${map.mineableCrystalUnits} units, ${formatUnits(map.conversionRateWei, 18)} Crystal/unit, ${formatUnits(map.maximumPayoutWei, 18)} Crystal cap`);
}
console.log(`Deployment confirmation: ${NFT_V2_MAINNET_CONFIRMATION}`);
console.log("Validation is read-only. No transaction was signed or broadcast.");
