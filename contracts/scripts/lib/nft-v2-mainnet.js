import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ZeroAddress, getAddress, isHexString } from "ethers";

const CONTRACTS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const NFT_V2_MAINNET_RELEASE_ID = "matt-mine-nft-v2-ronin";
export const NFT_V2_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V2_TO_RONIN_MAINNET";
export const NFT_V2_MAINNET_CHAIN_ID = 2020n;
export const NFT_V2_ROOT = getAddress("0xF79913cB83Cc9CABD95D0ba9250103fbb939f984");
export const NFT_V2_MAINNET_CONFIG_PATH = process.env.MATT_MINE_NFT_V2_MAINNET_CONFIG_PATH
  ? resolve(process.env.MATT_MINE_NFT_V2_MAINNET_CONFIG_PATH)
  : resolve(CONTRACTS_DIRECTORY, "config", "ronin-nft-v2.json");
export const EXPECTED_PROTOCOL = Object.freeze({
  mattToken: getAddress("0xa5450417BDCa0BDfB058ffE41205400FfDA1174d"),
  crystalToken: getAddress("0x2D2034e55900D285dc05d30a0c14846D7a30285B"),
  vrfCoordinator: getAddress("0xa18FD3db9B869AD2A8c55267e0D54dbf6ECEbEda")
});

function address(value, label) {
  let result;
  try { result = getAddress(value); } catch { throw new Error(`${label} must be a valid address.`); }
  if (result === ZeroAddress) throw new Error(`${label} must not be zero.`);
  return result;
}
function uint(value, label, maximum) {
  let result;
  try { result = BigInt(value); } catch { throw new Error(`${label} must be an unsigned integer.`); }
  if (result <= 0n || (maximum !== undefined && result > maximum)) throw new Error(`${label} is outside its approved range.`);
  return result;
}
function number(value, label, maximum) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result <= 0 || result > maximum) throw new Error(`${label} is outside its approved range.`);
  return result;
}
function bytes32(value, label) {
  if (!isHexString(value, 32) || /^0x0{64}$/i.test(value)) throw new Error(`${label} must be a nonzero bytes32.`);
  return value.toLowerCase();
}
function uri(value, label) {
  const result = String(value || "").trim();
  if (!/^(https:\/\/|ipfs:\/\/)/i.test(result) || /REPLACE/i.test(result)) throw new Error(`${label} must be a final HTTPS or IPFS URI.`);
  return result;
}

export function loadNftV2MainnetConfig() {
  if (!existsSync(NFT_V2_MAINNET_CONFIG_PATH)) {
    throw new Error(`Missing ${NFT_V2_MAINNET_CONFIG_PATH}. Copy config/ronin-nft-v2.example.json to config/ronin-nft-v2.json.`);
  }
  const raw = JSON.parse(readFileSync(NFT_V2_MAINNET_CONFIG_PATH, "utf8"));
  if (raw.releaseId !== NFT_V2_MAINNET_RELEASE_ID || BigInt(raw.chainId) !== NFT_V2_MAINNET_CHAIN_ID) throw new Error("Wrong V2 Ronin release or chain ID.");
  const protocol = {
    mattToken: address(raw.protocol?.mattToken, "MATT token"),
    crystalToken: address(raw.protocol?.crystalToken, "Crystal token"),
    vrfCoordinator: address(raw.protocol?.vrfCoordinator, "VRF coordinator"),
    vrfSubscriptionId: uint(raw.protocol?.vrfSubscriptionId, "VRF subscription ID"),
    vrfKeyHash: bytes32(raw.protocol?.vrfKeyHash, "VRF key hash")
  };
  for (const key of Object.keys(EXPECTED_PROTOCOL)) if (protocol[key] !== EXPECTED_PROTOCOL[key]) throw new Error(`${key} is not the approved Ronin contract.`);
  const roleKeys = ["rootAdmin", "treasury", "emergencyPauser", "gameOperator", "rewardSigner", "keeper"];
  const roles = Object.fromEntries(roleKeys.map((key) => [key, address(raw.roles?.[key], key)]));
  for (const [key, value] of Object.entries(roles)) if (value !== NFT_V2_ROOT) throw new Error(`${key} must initially be ${NFT_V2_ROOT}.`);
  const activationKeys = ["emergencyPauser", "gameOperator", "rewardSigner", "keeper", "configOperator"];
  const activationRoles = Object.fromEntries(activationKeys.map((key) => [key, address(raw.activationRoles?.[key], `activation ${key}`)]));
  if (activationRoles.gameOperator === activationRoles.rewardSigner) throw new Error("Activation Game Operator and Reward Signer must be separate.");
  const economy = Object.fromEntries([
    "repairPriceMattWei", "pickaxeChestPriceMattWei", "blasterChestPriceMattWei",
    "dynamiteChestPriceMattWei", "helmetChestPriceMattWei", "armorChestPriceMattWei",
    "backpackChestPriceMattWei"
  ].map((key) => [key, uint(raw.economy?.[key], key, (1n << 128n) - 1n)]));
  const maps = Object.fromEntries(["arena", "paid"].map((key) => {
    const map = raw.maps?.[key];
    return [key, {
      mapId: bytes32(map?.mapId, `${key} map ID`),
      contentHash: bytes32(map?.contentHash, `${key} content hash`),
      mineableCrystalUnits: number(map?.mineableCrystalUnits, `${key} mineable units`, 1_000_000),
      conversionRateWei: uint(map?.conversionRateWei, `${key} conversion`, 100_000n * 10n ** 18n),
      maximumPayoutWei: uint(map?.maximumPayoutWei, `${key} maximum payout`, 100_000n * 10n ** 18n),
      runTimeoutSeconds: number(map?.runTimeoutSeconds, `${key} timeout`, 86_400)
    }];
  }));
  for (const map of Object.values(maps)) if (map.runTimeoutSeconds < 300) throw new Error("Every map timeout must be at least five minutes.");
  return {
    releaseId: raw.releaseId, chainId: Number(raw.chainId), protocol, roles, activationRoles,
    metadata: {
      minerBaseUri: uri(raw.metadata?.minerBaseUri, "Miner base URI"),
      minerContractUri: uri(raw.metadata?.minerContractUri, "Miner contract URI"),
      equipmentBaseUri: uri(raw.metadata?.equipmentBaseUri, "Equipment base URI"),
      equipmentContractUri: uri(raw.metadata?.equipmentContractUri, "Equipment contract URI")
    },
    economy,
    definitions: {
      version: number(raw.definitions?.version, "definition version", 4_294_967_295),
      baseDefinitionId: number(raw.definitions?.baseDefinitionId, "base definition ID", 4_294_967_295)
    },
    maps,
    vrf: {
      requestConfirmations: number(raw.vrf?.requestConfirmations, "VRF confirmations", 200),
      coordinatorCallbackGasLimit: number(raw.vrf?.coordinatorCallbackGasLimit, "VRF callback gas", 5_000_000),
      consumerCallbackGasLimit: number(raw.vrf?.consumerCallbackGasLimit, "consumer callback gas", 4_000_000)
    }
  };
}

export async function validateNftV2MainnetNetwork(ethers, config, { checkMetadata = true } = {}) {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== NFT_V2_MAINNET_CHAIN_ID) throw new Error(`Connected to chain ${network.chainId}; expected 2020.`);
  for (const [key, target] of Object.entries(config.protocol)) {
    if (["vrfSubscriptionId", "vrfKeyHash"].includes(key)) continue;
    if ((await ethers.provider.getCode(target)) === "0x") throw new Error(`${key} has no contract code.`);
  }
  if (!checkMetadata) return;
  const abi = ["function name() view returns (string)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"];
  const matt = new Contract(config.protocol.mattToken, abi, ethers.provider);
  const crystal = new Contract(config.protocol.crystalToken, abi, ethers.provider);
  const values = await Promise.all([matt.name(), matt.symbol(), matt.decimals(), crystal.name(), crystal.symbol(), crystal.decimals()]);
  if (values[0] !== "Matt" || values[1] !== "MATT" || values[2] !== 18n) throw new Error("MATT token metadata mismatch.");
  if (values[3] !== "MATT CRYSTALS" || values[4] !== "CRYSTALS" || values[5] !== 18n) throw new Error("Crystal token metadata mismatch.");
}

export function jsonSafe(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
}
