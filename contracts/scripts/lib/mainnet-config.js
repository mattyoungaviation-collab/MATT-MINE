import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  Contract,
  ZeroAddress,
  getAddress,
  keccak256,
  toUtf8Bytes
} from "ethers";

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..", "..");

export const RONIN_CHAIN_ID = 2020n;
export const EXPECTED_PROTOCOL = Object.freeze({
  mattToken: getAddress("0xa5450417BDCa0BDfB058ffE41205400FfDA1174d"),
  wrappedRon: getAddress("0xe514d9deb7966c8be0ca922de8a064264ea6bcd4"),
  katanaRouter: getAddress("0x7d0556d55ca1a92708681e2e231733ebd922597d"),
  katanaFactory: getAddress("0xb255d6a720bb7c39fee173ce22113397119cb930"),
  mattWronPair: getAddress("0x92804d10806aaf51b82e8feeedadbb8218e2c2f9")
});

export const CONFIG_PATH = process.env.MATT_MINE_CONFIG_PATH
  ? resolve(process.env.MATT_MINE_CONFIG_PATH)
  : resolve(CONTRACTS_DIRECTORY, "config", "ronin.json");

export const DEPLOYMENT_PATH = process.env.MATT_MINE_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_DEPLOYMENT_PATH)
  : resolve(CONTRACTS_DIRECTORY, "deployments", "ronin.json");

function requiredObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requiredAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address`);
  }
  if (address === ZeroAddress) {
    throw new Error(`${label} has not been configured`);
  }
  return address;
}

function requiredUint(value, label) {
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) {
    throw new Error(`${label} must be an unsigned integer string`);
  }
  const number = BigInt(value);
  if (number === 0n) {
    throw new Error(`${label} must be greater than zero`);
  }
  return number;
}

function priceConfig(value, label) {
  const object = requiredObject(value, label);
  const initialPriceRonWei = requiredUint(
    object.initialPriceRonWei,
    `${label}.initialPriceRonWei`
  );
  const minimumPriceRonWei = requiredUint(
    object.minimumPriceRonWei,
    `${label}.minimumPriceRonWei`
  );
  const maximumPriceRonWei = requiredUint(
    object.maximumPriceRonWei,
    `${label}.maximumPriceRonWei`
  );
  if (
    minimumPriceRonWei > maximumPriceRonWei
    || initialPriceRonWei < minimumPriceRonWei
    || initialPriceRonWei > maximumPriceRonWei
  ) {
    throw new Error(`${label} prices are outside their configured bounds`);
  }
  return {
    initialPriceRonWei,
    minimumPriceRonWei,
    maximumPriceRonWei
  };
}

function adminSafeConfig(value) {
  const object = requiredObject(value, "adminSafe");
  if (!Array.isArray(object.owners) || object.owners.length !== 3) {
    throw new Error("adminSafe.owners must contain exactly three addresses");
  }
  const owners = object.owners
    .map((owner, index) => requiredAddress(owner, `adminSafe.owners[${index}]`))
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== owners.length) {
    throw new Error("adminSafe.owners must be unique");
  }
  if (object.threshold !== 2) {
    throw new Error("adminSafe.threshold must be 2");
  }
  return {
    threshold: 2,
    owners
  };
}

function stableValue(value) {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])])
    );
  }
  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

export function configHash(config) {
  return keccak256(toUtf8Bytes(stableStringify(config)));
}

export function acceptedDeploymentConfigHashes(config) {
  const hashes = new Set([configHash(config)]);
  if (config?.adminSafe?.threshold === 2) {
    hashes.add(configHash({
      ...config,
      adminSafe: { ...config.adminSafe, threshold: 1 }
    }));
  }
  return hashes;
}

export function normalizeMainnetConfig(rawConfig) {
  const raw = requiredObject(rawConfig, "configuration");
  if (typeof raw.releaseId !== "string" || raw.releaseId.trim().length < 3) {
    throw new Error("releaseId must identify this deployment");
  }
  if (BigInt(raw.chainId) !== RONIN_CHAIN_ID) {
    throw new Error(`chainId must be ${RONIN_CHAIN_ID}`);
  }

  const protocol = requiredObject(raw.protocol, "protocol");
  const normalizedProtocol = Object.fromEntries(
    Object.keys(EXPECTED_PROTOCOL).map((key) => [
      key,
      requiredAddress(protocol[key], `protocol.${key}`)
    ])
  );
  for (const [key, expected] of Object.entries(EXPECTED_PROTOCOL)) {
    if (normalizedProtocol[key] !== expected) {
      throw new Error(`protocol.${key} does not match the approved Ronin address`);
    }
  }

  const roles = requiredObject(raw.roles, "roles");
  const normalizedRoles = {
    contractAdminMultisig: requiredAddress(
      roles.contractAdminMultisig,
      "roles.contractAdminMultisig"
    ),
    priceManager: requiredAddress(roles.priceManager, "roles.priceManager"),
    configManager: requiredAddress(roles.configManager, "roles.configManager"),
    pauser: requiredAddress(roles.pauser, "roles.pauser"),
    rewardPublisher: requiredAddress(
      roles.rewardPublisher,
      "roles.rewardPublisher"
    ),
    treasuryManager: requiredAddress(
      roles.treasuryManager,
      "roles.treasuryManager"
    )
  };
  for (const key of ["priceManager", "configManager", "pauser"]) {
    if (normalizedRoles[key] === normalizedRoles.contractAdminMultisig) {
      throw new Error(
        `roles.${key} must be separate from the contract admin multisig`
      );
    }
  }
  if (
    normalizedRoles.pauser === normalizedRoles.priceManager
    || normalizedRoles.pauser === normalizedRoles.configManager
  ) {
    throw new Error(
      "roles.pauser must be separate from routine price and configuration management"
    );
  }
  if (
    normalizedRoles.rewardPublisher !== normalizedRoles.contractAdminMultisig
    && (
      normalizedRoles.rewardPublisher === normalizedRoles.priceManager
      || normalizedRoles.rewardPublisher === normalizedRoles.configManager
      || normalizedRoles.rewardPublisher === normalizedRoles.pauser
    )
  ) {
    throw new Error(
      "roles.rewardPublisher must use the admin multisig or a separate publisher address"
    );
  }

  const treasuries = requiredObject(raw.treasuries, "treasuries");
  const normalizedTreasuries = {
    operations: requiredAddress(treasuries.operations, "treasuries.operations"),
    passRewards: requiredAddress(
      treasuries.passRewards,
      "treasuries.passRewards"
    ),
    growth: requiredAddress(treasuries.growth, "treasuries.growth"),
    futureRewards: requiredAddress(
      treasuries.futureRewards,
      "treasuries.futureRewards"
    ),
    reserve: requiredAddress(treasuries.reserve, "treasuries.reserve")
  };
  const normalizedAdminSafe = adminSafeConfig(raw.adminSafe);
  if (
    normalizedAdminSafe.owners.includes(
      normalizedRoles.contractAdminMultisig
    )
  ) {
    throw new Error("The admin Safe cannot be one of its own owners");
  }

  return {
    releaseId: raw.releaseId.trim(),
    chainId: Number(RONIN_CHAIN_ID),
    protocol: normalizedProtocol,
    roles: normalizedRoles,
    adminSafe: normalizedAdminSafe,
    treasuries: normalizedTreasuries,
    pass: priceConfig(raw.pass, "pass"),
    paidRuns: priceConfig(raw.paidRuns, "paidRuns")
  };
}

export function loadMainnetConfig() {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `Missing ${CONFIG_PATH}. Copy config/ronin.example.json to config/ronin.json and fill every role and treasury address.`
    );
  }
  return normalizeMainnetConfig(JSON.parse(readFileSync(CONFIG_PATH, "utf8")));
}

export function loadDeploymentManifest() {
  if (!existsSync(DEPLOYMENT_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(DEPLOYMENT_PATH, "utf8"));
}

export function writeDeploymentManifest(manifest) {
  mkdirSync(dirname(DEPLOYMENT_PATH), { recursive: true });
  const temporaryPath = `${DEPLOYMENT_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w"
  });
  renameSync(temporaryPath, DEPLOYMENT_PATH);
}

async function requireCode(provider, address, label) {
  const code = await provider.getCode(address);
  if (code === "0x") {
    throw new Error(`${label} has no deployed code at ${address}`);
  }
}

export async function validateOnchainConfig(ethers, config) {
  const provider = ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== RONIN_CHAIN_ID) {
    throw new Error(
      `Connected to chain ${network.chainId}; expected Ronin Mainnet ${RONIN_CHAIN_ID}`
    );
  }

  for (const [key, address] of Object.entries(config.protocol)) {
    await requireCode(provider, address, `protocol.${key}`);
  }

  const protectedAddresses = new Map([
    [config.roles.contractAdminMultisig, "contract admin multisig"],
    [config.roles.treasuryManager, "treasury manager"],
    [config.treasuries.operations, "operations treasury"],
    [config.treasuries.passRewards, "pass rewards treasury"],
    [config.treasuries.growth, "growth treasury"],
    [config.treasuries.futureRewards, "future rewards treasury"],
    [config.treasuries.reserve, "reserve treasury"]
  ]);
  for (const [address, label] of protectedAddresses) {
    await requireCode(provider, address, label);
  }

  const adminSafe = new Contract(
    config.roles.contractAdminMultisig,
    [
      "function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)"
    ],
    provider
  );
  const [safeOwnersRaw, safeThreshold] = await Promise.all([
    adminSafe.getOwners(),
    adminSafe.getThreshold()
  ]);
  const safeOwners = safeOwnersRaw
    .map(getAddress)
    .sort((left, right) => left.toLowerCase().localeCompare(right.toLowerCase()));
  if (safeThreshold !== BigInt(config.adminSafe.threshold)) {
    throw new Error(
      `Admin Safe threshold is ${safeThreshold}; expected ${config.adminSafe.threshold}`
    );
  }
  if (
    safeOwners.length !== config.adminSafe.owners.length
    || safeOwners.some(
      (owner, index) => owner !== config.adminSafe.owners[index]
    )
  ) {
    throw new Error("Admin Safe owners do not match the approved configuration");
  }

  const token = new Contract(
    config.protocol.mattToken,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ],
    provider
  );
  const [symbol, decimals] = await Promise.all([
    token.symbol(),
    token.decimals()
  ]);
  if (symbol !== "MATT" || decimals !== 18n) {
    throw new Error(`Unexpected MATT token metadata: ${symbol}/${decimals}`);
  }

  const router = new Contract(
    config.protocol.katanaRouter,
    ["function factory() view returns (address)"],
    provider
  );
  if (getAddress(await router.factory()) !== config.protocol.katanaFactory) {
    throw new Error("Katana router factory does not match the approved factory");
  }

  const factory = new Contract(
    config.protocol.katanaFactory,
    ["function getPair(address,address) view returns (address)"],
    provider
  );
  const discoveredPair = getAddress(
    await factory.getPair(config.protocol.wrappedRon, config.protocol.mattToken)
  );
  if (discoveredPair !== config.protocol.mattWronPair) {
    throw new Error("Katana factory returned an unexpected MATT/WRON pair");
  }

  const pair = new Contract(
    config.protocol.mattWronPair,
    [
      "function token0() view returns (address)",
      "function token1() view returns (address)"
    ],
    provider
  );
  const pairTokens = new Set([
    getAddress(await pair.token0()),
    getAddress(await pair.token1())
  ]);
  if (
    !pairTokens.has(config.protocol.mattToken)
    || !pairTokens.has(config.protocol.wrappedRon)
  ) {
    throw new Error("Approved pair does not contain MATT and WRON");
  }

  return {
    chainId: network.chainId.toString(),
    mattSymbol: symbol,
    mattDecimals: decimals.toString(),
    safeOwners,
    safeThreshold: safeThreshold.toString(),
    pair: discoveredPair
  };
}
