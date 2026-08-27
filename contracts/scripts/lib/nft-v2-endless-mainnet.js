import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AbiCoder, ZeroAddress, getAddress, id, keccak256 } from "ethers";

const CONTRACTS_DIRECTORY = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ENDLESS_MAINNET_RELEASE_ID = "matt-mine-nft-v2-endless-ronin";
export const ENDLESS_MAINNET_CHAIN_ID = 2020n;
export const ENDLESS_MAINNET_CONFIRMATION = "DEPLOY_MATT_MINE_ENDLESS_TO_RONIN_MAINNET";
export const ENDLESS_MAINNET_ROOT = getAddress("0xF79913cB83Cc9CABD95D0ba9250103fbb939f984");
export const ENDLESS_MAINNET_CONFIG_PATH = process.env.MATT_MINE_ENDLESS_MAINNET_CONFIG_PATH
  ? resolve(process.env.MATT_MINE_ENDLESS_MAINNET_CONFIG_PATH)
  : resolve(CONTRACTS_DIRECTORY, "config", "ronin-nft-v2-endless.json");

const UINT128_MAX = (1n << 128n) - 1n;
const BASE_LABELS = Object.freeze({
  upgradeTimelock: "UpgradeTimelock",
  miner: "Miner",
  loadout: "Loadout",
  crystalBank: "CrystalBankProxy",
  passiveRewards: "PassiveRewardsProxy"
});

export function loadEndlessMainnetConfig(configPath = ENDLESS_MAINNET_CONFIG_PATH) {
  if (!existsSync(configPath)) {
    throw new Error(`Missing ${configPath}. Copy config/ronin-nft-v2-endless.example.json to config/ronin-nft-v2-endless.json.`);
  }
  const raw = JSON.parse(readFileSync(configPath, "utf8"));
  return normalizeEndlessMainnetConfig(raw, configPath);
}

export function normalizeEndlessMainnetConfig(raw, configPath = ENDLESS_MAINNET_CONFIG_PATH) {
  if (raw?.releaseId !== ENDLESS_MAINNET_RELEASE_ID || BigInt(raw?.chainId || 0) !== ENDLESS_MAINNET_CHAIN_ID) {
    throw new Error("Wrong Endless Ronin release or chain ID.");
  }
  const roles = Object.fromEntries(
    ["rootAdmin", "emergencyPauser", "gameOperator", "configOperator", "rewardSigner"]
      .map((key) => [key, address(raw.roles?.[key], key)])
  );
  if (roles.rootAdmin !== ENDLESS_MAINNET_ROOT) throw new Error(`Endless Root admin must be ${ENDLESS_MAINNET_ROOT}.`);
  if (roles.gameOperator === roles.rewardSigner) throw new Error("Game Operator and Reward Signer must be separate wallets.");
  const sourceVersions = raw.versions && typeof raw.versions === "object" && !Array.isArray(raw.versions)
    ? raw.versions
    : {};
  const versions = Object.fromEntries(Object.entries(sourceVersions).map(([name, value]) => {
    const economyVersion = String(name || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(economyVersion)) throw new Error(`Invalid economy version ${name}.`);
    return [economyVersion, normalizeVersion(economyVersion, value)];
  }));
  if (!Object.keys(versions).length) throw new Error("At least one Endless economy version is required.");
  return {
    releaseId: raw.releaseId,
    chainId: Number(raw.chainId),
    configPath: resolve(configPath),
    baseDeploymentPath: resolve(dirname(resolve(configPath)), String(raw.baseDeploymentPath || "")),
    roles,
    versions
  };
}

export function loadActivatedNftV2Base(config) {
  if (!existsSync(config.baseDeploymentPath)) throw new Error(`Missing activated NFT V2 manifest ${config.baseDeploymentPath}.`);
  const manifest = JSON.parse(readFileSync(config.baseDeploymentPath, "utf8"));
  if (manifest.scope !== "MattMineNftV2Ronin" || Number(manifest.chainId) !== Number(ENDLESS_MAINNET_CHAIN_ID) || manifest.status !== "activated") {
    throw new Error("The referenced NFT V2 base deployment is not the activated Ronin release.");
  }
  const contracts = Object.fromEntries(Object.entries(BASE_LABELS).map(([key, label]) => {
    return [key, address(manifest.contracts?.[label]?.address, `base ${label}`)];
  }));
  return { manifest, contracts };
}

export function buildEndlessVersion(economyVersion, value) {
  const configHash = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["string", "uint128", "uint128", "uint128", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "bool"],
    [
      economyVersion,
      value.conversionRate,
      value.maximumPayout,
      value.maximumDailyPayout,
      value.mineableCrystalUnits,
      value.maximumPhases,
      value.phaseXp,
      value.maximumRunXp,
      value.maximumWalletXpPerDay,
      value.maximumMinerXpPerDay,
      value.checkpointTimeout,
      value.failedRunsRetainXp
    ]
  ));
  const input = {
    generatorHash: id(value.generatorVersion),
    configHash,
    conversionRate: value.conversionRate,
    maximumPayout: value.maximumPayout,
    maximumDailyPayout: value.maximumDailyPayout,
    mineableCrystalUnits: value.mineableCrystalUnits,
    maximumPhases: value.maximumPhases,
    phaseXp: value.phaseXp,
    maximumRunXp: value.maximumRunXp,
    maximumWalletXpPerDay: value.maximumWalletXpPerDay,
    maximumMinerXpPerDay: value.maximumMinerXpPerDay,
    checkpointTimeout: value.checkpointTimeout,
    failedRunsRetainXp: value.failedRunsRetainXp,
    approved: false,
    retired: false
  };
  const versionId = keccak256(AbiCoder.defaultAbiCoder().encode(
    ["bytes32", "bytes32", "uint128", "uint128", "uint128", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "uint32", "bool"],
    [
      input.generatorHash,
      input.configHash,
      input.conversionRate,
      input.maximumPayout,
      input.maximumDailyPayout,
      input.mineableCrystalUnits,
      input.maximumPhases,
      input.phaseXp,
      input.maximumRunXp,
      input.maximumWalletXpPerDay,
      input.maximumMinerXpPerDay,
      input.checkpointTimeout,
      input.failedRunsRetainXp
    ]
  ));
  return { economyVersion, generatorVersion: value.generatorVersion, configHash, versionId, input };
}

function normalizeVersion(name, raw = {}) {
  const generatorVersion = String(raw.generatorVersion || "").trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(generatorVersion)) throw new Error(`${name} generator version is invalid.`);
  const value = {
    generatorVersion,
    conversionRate: uint(raw.conversionRateWei, `${name} conversion rate`, 100_000n * 10n ** 18n),
    maximumPayout: uint(raw.maximumPayoutWei, `${name} maximum payout`, 100_000n * 10n ** 18n),
    maximumDailyPayout: uint(raw.maximumDailyPayoutWei, `${name} daily payout`, 10_000_000n * 10n ** 18n),
    mineableCrystalUnits: number(raw.mineableCrystalUnits, `${name} mineable units`, 4_294_967_295),
    maximumPhases: number(raw.maximumPhases, `${name} maximum phases`, 1_000_000),
    phaseXp: number(raw.phaseXp, `${name} phase XP`, 1_000_000),
    maximumRunXp: number(raw.maximumRunXp, `${name} maximum run XP`, 1_000_000),
    maximumWalletXpPerDay: number(raw.maximumWalletXpPerDay, `${name} wallet XP cap`, 4_294_967_295),
    maximumMinerXpPerDay: number(raw.maximumMinerXpPerDay, `${name} Miner XP cap`, 4_294_967_295),
    checkpointTimeout: number(raw.checkpointTimeoutSeconds, `${name} checkpoint timeout`, 7 * 86_400)
  };
  if (value.checkpointTimeout < 300) throw new Error(`${name} checkpoint timeout must be at least five minutes.`);
  if (value.maximumDailyPayout < value.maximumPayout) throw new Error(`${name} daily payout cannot be lower than its run payout.`);
  value.failedRunsRetainXp = raw.failedRunsRetainXp === true;
  return buildEndlessVersion(name, value);
}

function address(value, label) {
  let result;
  try { result = getAddress(value); } catch { throw new Error(`${label} must be a valid address.`); }
  if (result === ZeroAddress) throw new Error(`${label} must not be zero.`);
  return result;
}

function uint(value, label, maximum = UINT128_MAX) {
  let result;
  try { result = BigInt(value); } catch { throw new Error(`${label} must be an unsigned integer.`); }
  if (result <= 0n || result > maximum) throw new Error(`${label} is outside its approved range.`);
  return result;
}

function number(value, label, maximum, allowZero = false) {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < (allowZero ? 0 : 1) || result > maximum) {
    throw new Error(`${label} is outside its approved range.`);
  }
  return result;
}
