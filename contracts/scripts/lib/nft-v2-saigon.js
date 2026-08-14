import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZeroAddress, getAddress, isHexString } from "ethers";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..", "..");

export const NFT_V2_SAIGON_RELEASE_ID = "matt-mine-nft-v2-saigon";
export const NFT_V2_SAIGON_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V2_TO_SAIGON";
export const NFT_V2_SAIGON_CHAIN_ID = 202601n;
export const NFT_V2_ROOT = getAddress("0xF79913cB83Cc9CABD95D0ba9250103fbb939f984");
export const NFT_V2_SAIGON_CONFIG_PATH = process.env.MATT_MINE_NFT_V2_SAIGON_CONFIG_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_SAIGON_CONFIG_PATH)
  : resolve(CONTRACTS_DIRECTORY, "config", "saigon-nft-v2.json");

function requiredAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address.`);
  }
  if (address === ZeroAddress) throw new Error(`${label} must not be zero.`);
  return address;
}

function requiredUint(value, label) {
  let parsed;
  try {
    parsed = BigInt(value);
  } catch {
    throw new Error(`${label} must be an unsigned integer.`);
  }
  if (parsed <= 0n) throw new Error(`${label} must be greater than zero.`);
  return parsed;
}

function requiredNumber(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${label} must be an integer from 1 through ${maximum}.`);
  }
  return parsed;
}

function requiredBytes32(value, label) {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) throw new Error(`${label} must be a nonzero bytes32.`);
  return value.toLowerCase();
}

function requiredUri(value, label) {
  const uri = String(value || "").trim();
  if (!/^(https:\/\/|ipfs:\/\/)/i.test(uri) || /REPLACE/i.test(uri)) {
    throw new Error(`${label} must be a final HTTPS or IPFS URI.`);
  }
  return uri;
}

export function loadNftV2SaigonConfig() {
  if (!existsSync(NFT_V2_SAIGON_CONFIG_PATH)) {
    throw new Error(
      `Missing ${NFT_V2_SAIGON_CONFIG_PATH}. Copy config/saigon-nft-v2.example.json to config/saigon-nft-v2.json.`
    );
  }
  const raw = JSON.parse(readFileSync(NFT_V2_SAIGON_CONFIG_PATH, "utf8"));
  if (raw.releaseId !== NFT_V2_SAIGON_RELEASE_ID) {
    throw new Error(`releaseId must be ${NFT_V2_SAIGON_RELEASE_ID}.`);
  }
  if (BigInt(raw.chainId) !== NFT_V2_SAIGON_CHAIN_ID) {
    throw new Error(`V2 Saigon config must target chain ${NFT_V2_SAIGON_CHAIN_ID}.`);
  }

  const roles = Object.fromEntries(Object.entries({
    rootAdmin: raw.roles?.rootAdmin,
    treasury: raw.roles?.treasury,
    emergencyPauser: raw.roles?.emergencyPauser,
    gameOperator: raw.roles?.gameOperator,
    rewardSigner: raw.roles?.rewardSigner,
    keeper: raw.roles?.keeper,
    randomnessOracle: raw.roles?.randomnessOracle
  }).map(([key, value]) => [key, requiredAddress(value, key)]));
  for (const [label, address] of Object.entries(roles)) {
    if (address !== NFT_V2_ROOT) {
      throw new Error(`${label} must initially be the approved bootstrap root ${NFT_V2_ROOT}.`);
    }
  }

  const economy = Object.fromEntries([
    "repairPriceMattWei",
    "pickaxeChestPriceMattWei",
    "blasterChestPriceMattWei",
    "dynamiteChestPriceMattWei",
    "helmetChestPriceMattWei",
    "armorChestPriceMattWei",
    "backpackChestPriceMattWei"
  ].map((key) => [key, requiredUint(raw.economy?.[key], key)]));

  const launchMap = {
    mapId: requiredBytes32(raw.launchMap?.mapId, "launch map ID"),
    contentHash: requiredBytes32(raw.launchMap?.contentHash, "launch map content hash"),
    mineableCrystalUnits: requiredNumber(
      raw.launchMap?.mineableCrystalUnits,
      "mineable Crystal units",
      4_294_967_295
    ),
    conversionRateWei: requiredUint(raw.launchMap?.conversionRateWei, "map conversion rate"),
    maximumPayoutWei: requiredUint(raw.launchMap?.maximumPayoutWei, "map maximum payout"),
    runTimeoutSeconds: requiredNumber(raw.launchMap?.runTimeoutSeconds, "run timeout", 86_400)
  };
  if (launchMap.conversionRateWei > 100_000n * 10n ** 18n) {
    throw new Error("Map conversion rate exceeds the immutable V2 ceiling.");
  }
  if (launchMap.maximumPayoutWei > 100_000n * 10n ** 18n) {
    throw new Error("Map maximum payout exceeds the immutable V2 per-run ceiling.");
  }
  if (launchMap.runTimeoutSeconds < 300) throw new Error("Run timeout must be at least five minutes.");

  return {
    releaseId: raw.releaseId,
    chainId: Number(raw.chainId),
    roles,
    metadata: {
      minerBaseUri: requiredUri(raw.metadata?.minerBaseUri, "Miner base URI"),
      minerContractUri: requiredUri(raw.metadata?.minerContractUri, "Miner contract URI"),
      equipmentBaseUri: requiredUri(raw.metadata?.equipmentBaseUri, "Equipment base URI"),
      equipmentContractUri: requiredUri(raw.metadata?.equipmentContractUri, "Equipment contract URI")
    },
    economy,
    definitions: {
      version: requiredNumber(raw.definitions?.version, "definition version", 4_294_967_295),
      baseDefinitionId: requiredNumber(raw.definitions?.baseDefinitionId, "base definition ID", 4_294_967_295)
    },
    launchMap,
    testTokens: {
      initialMattSupplyWei: requiredUint(raw.testTokens?.initialMattSupplyWei, "initial test MATT supply")
    }
  };
}

export async function validateNftV2SaigonNetwork(ethers) {
  const connected = await ethers.provider.getNetwork();
  if (connected.chainId !== NFT_V2_SAIGON_CHAIN_ID) {
    throw new Error(`Connected to chain ${connected.chainId}; expected Saigon ${NFT_V2_SAIGON_CHAIN_ID}.`);
  }
  return connected;
}
