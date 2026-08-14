import { formatUnits, keccak256, toUtf8Bytes } from "ethers";
import { network } from "hardhat";
import {
  NFT_V2_SAIGON_CONFIRMATION,
  loadNftV2SaigonConfig,
  validateNftV2SaigonNetwork
} from "./lib/nft-v2-saigon.js";

const { ethers } = await network.create();
const config = loadNftV2SaigonConfig();
await validateNftV2SaigonNetwork(ethers);
const safeConfig = JSON.parse(JSON.stringify(config, (_key, value) => typeof value === "bigint" ? value.toString() : value));

console.log("MATT Mine NFT V2 Saigon configuration is structurally valid.");
console.log(`Config hash: ${keccak256(toUtf8Bytes(JSON.stringify(safeConfig)))}`);
console.log(`Bootstrap root and initial roles: ${config.roles.rootAdmin}`);
console.log(`Normal-map conversion: ${formatUnits(config.launchMap.conversionRateWei, 18)} MATT Crystal per in-game Crystal`);
console.log(`Per-run map maximum: ${formatUnits(config.launchMap.maximumPayoutWei, 18)} MATT Crystals`);
console.log(`Deployment confirmation: ${NFT_V2_SAIGON_CONFIRMATION}`);
console.log("Validation is read-only. No transaction was signed or broadcast.");
