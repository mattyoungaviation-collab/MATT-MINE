import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ZeroAddress, getAddress } from "ethers";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..", "..");

export const NFT_SAIGON_RELEASE_ID = "matt-mine-nft-v1-saigon";
export const NFT_SAIGON_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V1_TO_SAIGON";
export const SAIGON_CHAIN_ID = 202601n;
export const NFT_SAIGON_CONFIG_PATH = process.env.MATT_MINE_NFT_SAIGON_CONFIG_PATH
  ? resolve(process.env.MATT_MINE_NFT_SAIGON_CONFIG_PATH)
  : resolve(CONTRACTS_DIRECTORY, "config", "saigon-nft.json");

export const APPROVED_NFT_ADMIN = getAddress("0xF79913cB83Cc9CABD95D0ba9250103fbb939f984");

function requiredAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address.`);
  }
  if (address === ZeroAddress) throw new Error(`${label} must not be the zero address.`);
  return address;
}

function requiredUint(value, label) {
  let number;
  try {
    number = BigInt(value);
  } catch {
    throw new Error(`${label} must be an unsigned integer string.`);
  }
  if (number <= 0n) throw new Error(`${label} must be greater than zero.`);
  return number;
}

function requiredUri(value, label) {
  const uri = String(value || "").trim();
  if (!/^(https:\/\/|ipfs:\/\/)/i.test(uri) || /REPLACE/i.test(uri)) {
    throw new Error(`${label} must be a final HTTPS or IPFS URI.`);
  }
  return uri;
}

export function loadNftSaigonConfig() {
  if (!existsSync(NFT_SAIGON_CONFIG_PATH)) {
    throw new Error(
      `Missing ${NFT_SAIGON_CONFIG_PATH}. Copy config/saigon-nft.example.json to config/saigon-nft.json.`
    );
  }
  const raw = JSON.parse(readFileSync(NFT_SAIGON_CONFIG_PATH, "utf8"));
  if (raw.releaseId !== NFT_SAIGON_RELEASE_ID) {
    throw new Error(`releaseId must be ${NFT_SAIGON_RELEASE_ID}.`);
  }
  if (Number(raw.chainId) !== Number(SAIGON_CHAIN_ID)) {
    throw new Error(`NFT Saigon config must target chain ${SAIGON_CHAIN_ID}.`);
  }

  const roles = {
    contractAdmin: requiredAddress(raw.roles?.contractAdmin, "contract admin"),
    emergencyPauser: requiredAddress(raw.roles?.emergencyPauser, "emergency pauser"),
    gameOperator: requiredAddress(raw.roles?.gameOperator, "game operator"),
    gameSigner: requiredAddress(raw.roles?.gameSigner, "game signer"),
    redemptionSigner: requiredAddress(raw.roles?.redemptionSigner, "redemption signer"),
    randomnessOracle: requiredAddress(raw.roles?.randomnessOracle, "test randomness oracle")
  };
  if (roles.contractAdmin !== APPROVED_NFT_ADMIN) {
    throw new Error("Every Saigon contract must be controlled by the approved 0xF799 admin wallet.");
  }
  const separated = [
    roles.contractAdmin,
    roles.emergencyPauser,
    roles.gameOperator,
    roles.gameSigner,
    roles.redemptionSigner
  ];
  if (new Set(separated.map((address) => address.toLowerCase())).size !== separated.length) {
    throw new Error("Admin, pauser, operator, and signing roles must use separate addresses.");
  }

  const economy = Object.fromEntries([
    "repairPriceMattWei",
    "weaponChestPriceMattWei",
    "helmetChestPriceMattWei",
    "commonArmorChestPriceMattWei",
    "rareArmorChestPriceMattWei",
    "mythicArmorChestPriceMattWei",
    "backpackPriceMattWei",
    "minimumCrystalWithdrawalWei",
    "maximumDailyCrystalWithdrawalWei"
  ].map((key) => [key, requiredUint(raw.economy?.[key], key)]));
  economy.backpackDefinitionId = Number(requiredUint(raw.economy?.backpackDefinitionId, "backpack definition ID"));
  if (economy.minimumCrystalWithdrawalWei > economy.maximumDailyCrystalWithdrawalWei) {
    throw new Error("Minimum Crystal withdrawal cannot exceed the daily maximum.");
  }

  return {
    releaseId: raw.releaseId,
    chainId: Number(raw.chainId),
    roles,
    treasury: { vault: requiredAddress(raw.treasury?.vault, "test payment vault") },
    metadata: {
      minerBaseUri: requiredUri(raw.metadata?.minerBaseUri, "Miner base URI"),
      minerContractUri: requiredUri(raw.metadata?.minerContractUri, "Miner contract URI"),
      equipmentBaseUri: requiredUri(raw.metadata?.equipmentBaseUri, "Equipment base URI"),
      equipmentContractUri: requiredUri(raw.metadata?.equipmentContractUri, "Equipment contract URI")
    },
    economy,
    testTokens: {
      initialMattSupplyWei: requiredUint(raw.testTokens?.initialMattSupplyWei, "initial test MATT supply")
    }
  };
}

export async function validateNftSaigonNetwork(ethers) {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== SAIGON_CHAIN_ID) {
    throw new Error(`Connected to chain ${network.chainId}; expected Saigon ${SAIGON_CHAIN_ID}.`);
  }
  return network;
}
