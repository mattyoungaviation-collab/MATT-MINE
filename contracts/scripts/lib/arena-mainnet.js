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
  getAddress
} from "ethers";
import {
  EXPECTED_PROTOCOL,
  RONIN_CHAIN_ID,
  configHash,
  loadMainnetConfig
} from "./mainnet-config.js";

export { RONIN_CHAIN_ID };

const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const CONTRACTS_DIRECTORY = resolve(SCRIPT_DIRECTORY, "..", "..");

export const ARENA_DEPLOYMENT_SCOPE = "MattMineDailyArenaOnly";
export const ARENA_RELEASE_ID = "matt-mine-daily-arena-v1";
export const ARENA_MAINNET_CONFIRMATION =
  "DEPLOY_MATT_MINE_DAILY_ARENA_TO_RONIN_MAINNET";
export const ARENA_DEPLOYMENT_PATH = process.env
  .MATT_MINE_ARENA_DEPLOYMENT_PATH
  ? resolve(process.env.MATT_MINE_ARENA_DEPLOYMENT_PATH)
  : resolve(CONTRACTS_DIRECTORY, "deployments", "arena-ronin.json");

const EXPECTED_CONSTANTS = Object.freeze({
  dayDuration: 86_400n,
  entryCutoffDuration: 1_500n,
  minimumEntryFeeMatt: 25_000n * 10n ** 18n,
  maximumEntryFeeMatt: 1_000_000n * 10n ** 18n,
  maximumDailySeedMatt: 10_000_000n * 10n ** 18n,
  maximumWinners: 10n
});

function requiredAddress(value, label) {
  let address;
  try {
    address = getAddress(value);
  } catch {
    throw new Error(`${label} must be a valid EVM address.`);
  }
  if (address === ZeroAddress) {
    throw new Error(`${label} must not be the zero address.`);
  }
  return address;
}

function sortedAddresses(addresses) {
  return addresses
    .map((address, index) =>
      requiredAddress(address, `Treasury Safe owner ${index + 1}`)
    )
    .sort((left, right) =>
      left.toLowerCase().localeCompare(right.toLowerCase())
    );
}

/**
 * Arena control is deliberately derived from the already approved production
 * configuration. This avoids a second, potentially divergent copy of the MATT
 * token or Treasury Safe address.
 *
 * Pricing and settlement are both Safe-controlled. The existing emergency
 * pauser remains the only routine EOA role.
 */
export function loadArenaMainnetConfig() {
  const mainnet = loadMainnetConfig();
  const treasurySafe = requiredAddress(
    mainnet.roles.contractAdminMultisig,
    "Treasury Safe"
  );
  const emergencyPauser = requiredAddress(
    mainnet.roles.pauser,
    "Arena emergency pauser"
  );
  const owners = sortedAddresses(mainnet.adminSafe.owners);

  if (mainnet.adminSafe.threshold !== 2 || owners.length !== 3) {
    throw new Error("The Treasury Safe must remain a 2-of-3 Safe.");
  }
  if (new Set(owners.map((owner) => owner.toLowerCase())).size !== 3) {
    throw new Error("The Treasury Safe owners must be unique.");
  }
  if (owners.includes(treasurySafe)) {
    throw new Error("The Treasury Safe cannot be one of its own owners.");
  }
  if (treasurySafe === emergencyPauser) {
    throw new Error(
      "The Arena emergency pauser must remain separate from the Treasury Safe."
    );
  }

  const mattToken = requiredAddress(
    mainnet.protocol.mattToken,
    "MATT token"
  );
  if (mattToken !== EXPECTED_PROTOCOL.mattToken) {
    throw new Error("The Arena MATT token is not the approved live MATT token.");
  }

  return {
    releaseId: ARENA_RELEASE_ID,
    chainId: Number(RONIN_CHAIN_ID),
    protocol: {
      mattToken
    },
    treasurySafe,
    roles: {
      // Daily pricing and final settlement both require the Treasury Safe.
      pricer: treasurySafe,
      settler: treasurySafe,
      emergencyPauser
    },
    adminSafe: {
      threshold: 2,
      owners
    }
  };
}

export function arenaConfigHash(config) {
  return configHash(config);
}

export function arenaConstructorArgs(config) {
  return [
    config.protocol.mattToken,
    config.treasurySafe,
    config.roles.settler,
    config.roles.pricer,
    config.roles.emergencyPauser
  ];
}

export function loadArenaDeploymentManifest() {
  if (!existsSync(ARENA_DEPLOYMENT_PATH)) {
    return null;
  }
  return JSON.parse(readFileSync(ARENA_DEPLOYMENT_PATH, "utf8"));
}

export function writeArenaDeploymentManifest(manifest) {
  mkdirSync(dirname(ARENA_DEPLOYMENT_PATH), { recursive: true });
  const temporaryPath = `${ARENA_DEPLOYMENT_PATH}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "w"
  });
  renameSync(temporaryPath, ARENA_DEPLOYMENT_PATH);
}

export function assertArenaManifest(manifest, config, deployerAddress) {
  if (manifest === null || typeof manifest !== "object") {
    throw new Error("The Arena deployment manifest is missing or invalid.");
  }
  if (manifest.scope !== ARENA_DEPLOYMENT_SCOPE) {
    throw new Error(
      "The deployment manifest is not isolated to MattMineDailyArena."
    );
  }
  if (manifest.chainId !== Number(RONIN_CHAIN_ID)) {
    throw new Error(
      `Arena deployment manifest targets chain ${manifest.chainId}; expected ${RONIN_CHAIN_ID}.`
    );
  }
  if (manifest.configHash !== arenaConfigHash(config)) {
    throw new Error(
      "Arena deployment manifest does not match the approved configuration."
    );
  }
  if (
    deployerAddress !== undefined
    && getAddress(manifest.deployer) !== getAddress(deployerAddress)
  ) {
    throw new Error(
      "The Arena deployment must be resumed with its original deployment signer."
    );
  }

  const labels = Object.keys(manifest.contracts ?? {});
  if (
    labels.some((label) => label !== "MattMineDailyArena")
    || labels.length > 1
  ) {
    throw new Error(
      "Arena deployment manifest contains a contract outside the isolated Arena scope."
    );
  }
}

async function requireCode(provider, address, label) {
  if ((await provider.getCode(address)) === "0x") {
    throw new Error(`${label} has no deployed code at ${address}.`);
  }
}

export async function validateArenaOnchainConfig(ethers, config) {
  const provider = ethers.provider;
  const network = await provider.getNetwork();
  if (network.chainId !== RONIN_CHAIN_ID) {
    throw new Error(
      `Connected to chain ${network.chainId}; expected Ronin Mainnet ${RONIN_CHAIN_ID}.`
    );
  }

  await requireCode(provider, config.protocol.mattToken, "MATT token");
  await requireCode(provider, config.treasurySafe, "Treasury Safe");

  const matt = new Contract(
    config.protocol.mattToken,
    [
      "function symbol() view returns (string)",
      "function decimals() view returns (uint8)"
    ],
    provider
  );
  const [symbol, decimals] = await Promise.all([
    matt.symbol(),
    matt.decimals()
  ]);
  if (symbol !== "MATT" || decimals !== 18n) {
    throw new Error(`Unexpected MATT token metadata: ${symbol}/${decimals}.`);
  }

  const safe = new Contract(
    config.treasurySafe,
    [
      "function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)"
    ],
    provider
  );
  const [ownersRaw, threshold] = await Promise.all([
    safe.getOwners(),
    safe.getThreshold()
  ]);
  const owners = sortedAddresses(ownersRaw);
  if (threshold !== BigInt(config.adminSafe.threshold)) {
    throw new Error(
      `Treasury Safe threshold is ${threshold}; expected ${config.adminSafe.threshold}.`
    );
  }
  if (
    owners.length !== config.adminSafe.owners.length
    || owners.some((owner, index) => owner !== config.adminSafe.owners[index])
  ) {
    throw new Error(
      "Treasury Safe owners do not match the approved production configuration."
    );
  }

  return {
    chainId: network.chainId.toString(),
    mattSymbol: symbol,
    mattDecimals: decimals.toString(),
    treasurySafe: config.treasurySafe,
    safeOwners: owners,
    safeThreshold: threshold.toString()
  };
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label} is ${actual}; expected ${expected}.`);
  }
}

function expectAddress(actual, expected, label) {
  expectEqual(getAddress(actual), getAddress(expected), label);
}

async function expectRole(contract, role, account, expected, label) {
  expectEqual(await contract.hasRole(role, account), expected, label);
}

export async function verifyArenaDeploymentState(
  ethers,
  config,
  manifest,
  { requireEmptyBalances = true } = {}
) {
  assertArenaManifest(manifest, config);
  const record = manifest.contracts?.MattMineDailyArena;
  const addressRaw = record?.address ?? record?.predictedAddress;
  if (!addressRaw) {
    throw new Error(
      "MattMineDailyArena address is missing from the Arena deployment manifest."
    );
  }
  const address = getAddress(addressRaw);
  await requireCode(ethers.provider, address, "MattMineDailyArena");

  const arena = await ethers.getContractAt("MattMineDailyArena", address);
  const deployer = getAddress(manifest.deployer);
  const defaultAdminRole = await arena.DEFAULT_ADMIN_ROLE();
  const treasuryRole = await arena.TREASURY_ROLE();
  const settlerRole = await arena.SETTLER_ROLE();
  const pricerRole = await arena.PRICER_ROLE();
  const pauserRole = await arena.PAUSER_ROLE();

  expectAddress(await arena.matt(), config.protocol.mattToken, "Arena MATT");
  expectAddress(
    await arena.seedTreasury(),
    config.treasurySafe,
    "Arena seed treasury"
  );
  await expectRole(
    arena,
    defaultAdminRole,
    config.treasurySafe,
    true,
    "Treasury Safe default admin role"
  );
  await expectRole(
    arena,
    treasuryRole,
    config.treasurySafe,
    true,
    "Treasury Safe seed role"
  );
  await expectRole(
    arena,
    settlerRole,
    config.roles.settler,
    true,
    "Treasury Safe settler role"
  );
  await expectRole(
    arena,
    pricerRole,
    config.roles.pricer,
    true,
    "Treasury Safe pricer role"
  );
  await expectRole(
    arena,
    pauserRole,
    config.roles.emergencyPauser,
    true,
    "Arena emergency pauser role"
  );

  for (const [role, label] of [
    [defaultAdminRole, "default admin"],
    [treasuryRole, "treasury"],
    [settlerRole, "settler"],
    [pricerRole, "pricer"],
    [pauserRole, "pauser"]
  ]) {
    await expectRole(
      arena,
      role,
      deployer,
      false,
      `Temporary deployer ${label} role removal`
    );
  }

  expectEqual(
    await arena.DAY_DURATION(),
    EXPECTED_CONSTANTS.dayDuration,
    "Arena day duration"
  );
  expectEqual(
    await arena.ENTRY_CUTOFF_DURATION(),
    EXPECTED_CONSTANTS.entryCutoffDuration,
    "Arena entry cutoff duration"
  );
  expectEqual(
    await arena.MIN_ENTRY_FEE_MATT(),
    EXPECTED_CONSTANTS.minimumEntryFeeMatt,
    "Arena minimum entry fee"
  );
  expectEqual(
    await arena.MAX_ENTRY_FEE_MATT(),
    EXPECTED_CONSTANTS.maximumEntryFeeMatt,
    "Arena maximum entry fee"
  );
  expectEqual(
    await arena.MAX_DAILY_SEED_MATT(),
    EXPECTED_CONSTANTS.maximumDailySeedMatt,
    "Arena maximum daily Treasury seed"
  );
  expectEqual(
    await arena.MAX_WINNERS(),
    EXPECTED_CONSTANTS.maximumWinners,
    "Arena maximum winners"
  );
  expectEqual(
    await arena.entriesPaused(),
    true,
    "Arena must deploy with entries paused"
  );
  expectEqual(
    await arena.settlementPaused(),
    false,
    "Arena settlement pause state"
  );

  if (requireEmptyBalances) {
    const matt = new Contract(
      config.protocol.mattToken,
      ["function balanceOf(address) view returns (uint256)"],
      ethers.provider
    );
    const [ronBalance, mattBalance, reservedMatt, excessMatt, nextEntry] =
      await Promise.all([
        ethers.provider.getBalance(address),
        matt.balanceOf(address),
        arena.totalReservedMatt(),
        arena.availableExcessMatt(),
        arena.nextEntryNumber()
      ]);
    expectEqual(ronBalance, 0n, "Arena RON balance before activation");
    expectEqual(mattBalance, 0n, "Arena MATT balance before activation");
    expectEqual(reservedMatt, 0n, "Arena reserved MATT before activation");
    expectEqual(excessMatt, 0n, "Arena excess MATT before activation");
    expectEqual(nextEntry, 1n, "Arena next entry number before activation");
  }

  return {
    address,
    treasurySafe: config.treasurySafe,
    emergencyPauser: config.roles.emergencyPauser,
    constants: {
      dayDuration: EXPECTED_CONSTANTS.dayDuration.toString(),
      entryCutoffDuration:
        EXPECTED_CONSTANTS.entryCutoffDuration.toString(),
      minimumEntryFeeMatt: EXPECTED_CONSTANTS.minimumEntryFeeMatt.toString(),
      maximumEntryFeeMatt: EXPECTED_CONSTANTS.maximumEntryFeeMatt.toString(),
      maximumDailySeedMatt:
        EXPECTED_CONSTANTS.maximumDailySeedMatt.toString(),
      maximumWinners: EXPECTED_CONSTANTS.maximumWinners.toString()
    }
  };
}
