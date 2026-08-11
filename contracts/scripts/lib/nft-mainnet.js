import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Contract, ZeroAddress, getAddress, isHexString } from "ethers";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..", "..");

export const NFT_RELEASE_ID = "matt-mine-nft-v1";
export const NFT_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_NFT_V1_TO_RONIN_MAINNET";
export const RONIN_CHAIN_ID = 2020n;
export const NFT_CONFIG_PATH = process.env.MATT_MINE_NFT_CONFIG_PATH
  ? resolve(process.env.MATT_MINE_NFT_CONFIG_PATH)
  : resolve(CONTRACTS_DIRECTORY, "config", "ronin-nft.json");

export const EXPECTED_NFT_PROTOCOL = Object.freeze({
  mattToken: getAddress("0xa5450417BDCa0BDfB058ffE41205400FfDA1174d"),
  crystalToken: getAddress("0x2D2034e55900D285dc05d30a0c14846D7a30285B"),
  vrfCoordinator: getAddress("0xa18FD3db9B869AD2A8c55267e0D54dbf6ECEbEda"),
  paymentVault: getAddress("0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc"),
  contractAdmin: getAddress("0xF79913cB83Cc9CABD95D0ba9250103fbb939f984")
});

const ERC20_METADATA_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)"
];

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

function requiredUint(value, label, { allowZero = false } = {}) {
  let number;
  try {
    number = BigInt(value);
  } catch {
    throw new Error(`${label} must be an unsigned integer string.`);
  }
  if (number < 0n || (!allowZero && number === 0n)) {
    throw new Error(`${label} must be ${allowZero ? "non-negative" : "greater than zero"}.`);
  }
  return number;
}

function requiredUri(value, label) {
  const uri = String(value || "").trim();
  if (!/^(https:\/\/|ipfs:\/\/)/i.test(uri) || /REPLACE/i.test(uri)) {
    throw new Error(`${label} must be a final HTTPS or IPFS URI.`);
  }
  return uri;
}

export function loadNftMainnetConfig() {
  if (!existsSync(NFT_CONFIG_PATH)) {
    throw new Error(
      `Missing ${NFT_CONFIG_PATH}. Copy config/ronin-nft.example.json to config/ronin-nft.json and fill every placeholder.`
    );
  }
  const raw = JSON.parse(readFileSync(NFT_CONFIG_PATH, "utf8"));
  if (raw.releaseId !== NFT_RELEASE_ID) throw new Error(`releaseId must be ${NFT_RELEASE_ID}.`);
  if (Number(raw.chainId) !== Number(RONIN_CHAIN_ID)) throw new Error("NFT config must target Ronin Mainnet chain 2020.");

  const protocol = {
    mattToken: requiredAddress(raw.protocol?.mattToken, "MATT token"),
    crystalToken: requiredAddress(raw.protocol?.crystalToken, "Crystal token"),
    vrfCoordinator: requiredAddress(raw.protocol?.vrfCoordinator, "VRF coordinator"),
    vrfSubscriptionId: requiredUint(raw.protocol?.vrfSubscriptionId, "VRF subscription ID"),
    vrfKeyHash: raw.protocol?.vrfKeyHash
  };
  for (const key of ["mattToken", "crystalToken", "vrfCoordinator"]) {
    if (protocol[key] !== EXPECTED_NFT_PROTOCOL[key]) {
      throw new Error(`${key} is not the approved live Ronin address.`);
    }
  }
  if (!isHexString(protocol.vrfKeyHash, 32)) throw new Error("VRF key hash must be bytes32.");

  const roles = {
    contractAdmin: requiredAddress(raw.roles?.contractAdmin, "contract admin"),
    emergencyPauser: requiredAddress(raw.roles?.emergencyPauser, "emergency pauser"),
    gameOperator: requiredAddress(raw.roles?.gameOperator, "game operator"),
    gameSigner: requiredAddress(raw.roles?.gameSigner, "game signer"),
    redemptionSigner: requiredAddress(raw.roles?.redemptionSigner, "redemption signer")
  };
  const vault = requiredAddress(raw.treasury?.vault, "NFT payment vault");
  if (roles.contractAdmin !== EXPECTED_NFT_PROTOCOL.contractAdmin) {
    throw new Error("All NFT contracts must be controlled by the approved 0xF799 admin wallet.");
  }
  if (vault !== EXPECTED_NFT_PROTOCOL.paymentVault) {
    throw new Error("NFT payments must route to the approved Treasury Safe vault.");
  }
  const separation = [roles.contractAdmin, roles.emergencyPauser, roles.gameOperator, roles.gameSigner, roles.redemptionSigner];
  if (new Set(separation.map((address) => address.toLowerCase())).size !== separation.length) {
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

  const vrf = {
    requestConfirmations: Number(requiredUint(raw.vrf?.requestConfirmations, "VRF confirmations")),
    coordinatorCallbackGasLimit: Number(requiredUint(raw.vrf?.coordinatorCallbackGasLimit, "VRF coordinator callback gas")),
    consumerCallbackGasLimit: Number(requiredUint(raw.vrf?.consumerCallbackGasLimit, "VRF consumer callback gas")),
    requestTimeoutSeconds: Number(requiredUint(raw.vrf?.requestTimeoutSeconds, "VRF timeout"))
  };
  if (vrf.requestConfirmations < 3) throw new Error("VRF confirmations must be at least 3.");
  if (vrf.consumerCallbackGasLimit > vrf.coordinatorCallbackGasLimit) {
    throw new Error("Consumer callback gas cannot exceed coordinator callback gas.");
  }

  return {
    releaseId: raw.releaseId,
    chainId: Number(raw.chainId),
    protocol,
    roles,
    treasury: { vault },
    metadata: {
      minerBaseUri: requiredUri(raw.metadata?.minerBaseUri, "Miner base URI"),
      minerContractUri: requiredUri(raw.metadata?.minerContractUri, "Miner contract URI"),
      equipmentBaseUri: requiredUri(raw.metadata?.equipmentBaseUri, "Equipment base URI"),
      equipmentContractUri: requiredUri(raw.metadata?.equipmentContractUri, "Equipment contract URI")
    },
    economy,
    vrf
  };
}

async function requireCode(provider, address, label) {
  if ((await provider.getCode(address)) === "0x") throw new Error(`${label} has no code at ${address}.`);
}

export async function validateNftOnchainConfig(ethers, config) {
  const network = await ethers.provider.getNetwork();
  if (network.chainId !== RONIN_CHAIN_ID) throw new Error(`Connected to chain ${network.chainId}; expected 2020.`);
  await Promise.all([
    requireCode(ethers.provider, config.protocol.mattToken, "MATT token"),
    requireCode(ethers.provider, config.protocol.crystalToken, "Crystal token"),
    requireCode(ethers.provider, config.protocol.vrfCoordinator, "VRF coordinator"),
    requireCode(ethers.provider, config.treasury.vault, "Treasury Safe vault")
  ]);

  const matt = new Contract(config.protocol.mattToken, ERC20_METADATA_ABI, ethers.provider);
  const crystal = new Contract(config.protocol.crystalToken, ERC20_METADATA_ABI, ethers.provider);
  const [mattName, mattSymbol, mattDecimals, crystalName, crystalSymbol, crystalDecimals] = await Promise.all([
    matt.name(), matt.symbol(), matt.decimals(), crystal.name(), crystal.symbol(), crystal.decimals()
  ]);
  if (mattName !== "Matt" || mattSymbol !== "MATT" || mattDecimals !== 18n) {
    throw new Error("The configured MATT contract metadata does not match the live token.");
  }
  if (crystalName !== "MATT CRYSTALS" || crystalSymbol !== "CRYSTALS" || crystalDecimals !== 18n) {
    throw new Error("The configured Crystal contract metadata does not match the live token.");
  }
}
