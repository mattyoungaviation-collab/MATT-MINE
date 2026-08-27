/**
 * MATT Mine Endless shared rules.
 *
 * This module intentionally has no Node-only dependencies. The API server and
 * browser use the same normalization, seed derivation, map generator, scoring
 * solver, capability model, and validator. A server signature is still needed
 * before a generated manifest is accepted for rewards.
 */

export const ENDLESS_GENERATOR_VERSION = 'endless-map-v2';
export const ENDLESS_SUPPORTED_GENERATOR_VERSIONS = Object.freeze(['endless-map-v1', ENDLESS_GENERATOR_VERSION]);
export const ENDLESS_CONFIG_VERSION = 1;
export const ENDLESS_ENTRY_PRICE_MIN = 0;
export const ENDLESS_ENTRY_PRICE_MAX = 10_000_000;
export const ENDLESS_MAX_PHASE = 1_000_000;

export const ENDLESS_CONSERVATIVE_ECONOMY_PRESET = Object.freeze({
  economyVersion: 'endless-conservative-v1',
  crystalConversionNumerator: 1,
  crystalConversionDenominator: 400,
  mineableCrystalUnits: 3_750,
  maximumPayoutNumerator: 10,
  maximumPayoutDenominator: 1,
  maximumDailyPayoutNumerator: 500,
  maximumDailyPayoutDenominator: 1,
  maximumPhases: ENDLESS_MAX_PHASE,
  phaseXp: 10,
  maximumRunXp: 500,
  maximumWalletXpPerDay: 2_500,
  maximumMinerXpPerDay: 2_500,
  checkpointTimeoutSeconds: 86_400,
  failedRunsRetainXp: false
});

export const ENDLESS_ENEMY_TYPES = Object.freeze([
  'slime', 'bat', 'crawler', 'beetle', 'exploder', 'spitter'
]);
export const ENDLESS_ORE_TYPES = Object.freeze(['stone', 'copper', 'gold', 'crystal']);
export const ENDLESS_HAZARD_TYPES = Object.freeze(['rockfall', 'crystal_field']);

const LEGACY_ROOM_TEMPLATES_V1 = Object.freeze([
  Object.freeze([
    ['lift', 0.7, 3.2, 1.45, 1.45, 'start', 'Lift Station'],
    ['vein-a', 2.55, 3.2, 1.65, 1.55, 'mining', 'Shimmering Vein'],
    ['crossing', 4.45, 3.2, 1.7, 1.65, 'mixed', 'Broken Crossing'],
    ['cache', 4.45, 1.15, 1.55, 1.3, 'treasure', 'Prospector Cache'],
    ['works', 6.35, 3.2, 1.7, 1.65, 'combat', 'Old Workings'],
    ['deep-vein', 6.35, 5.25, 1.6, 1.35, 'mining', 'Deep Vein'],
    ['vault', 8.45, 3.2, 2.05, 2.0, 'guardian', 'Guardian Vault']
  ]),
  Object.freeze([
    ['lift', 0.75, 3.1, 1.45, 1.45, 'start', 'Lift Station'],
    ['fork', 2.55, 3.1, 1.65, 1.55, 'mixed', 'Collapsed Fork'],
    ['upper', 4.35, 1.15, 1.55, 1.35, 'combat', 'Bat Gallery'],
    ['lower', 4.35, 5.15, 1.55, 1.35, 'mining', 'Copper Shelf'],
    ['relay', 6.15, 3.1, 1.7, 1.65, 'combat', 'Dust Relay'],
    ['cache', 7.9, 5.15, 1.55, 1.35, 'treasure', 'Lost Cache'],
    ['vault', 8.4, 2.25, 2.05, 2.0, 'guardian', 'Guardian Vault']
  ]),
  Object.freeze([
    ['lift', 0.75, 3.25, 1.45, 1.45, 'start', 'Lift Station'],
    ['gallery', 2.45, 3.25, 1.55, 1.55, 'mining', 'Crystal Gallery'],
    ['rise', 3.95, 1.25, 1.45, 1.3, 'combat', 'Exploder Rise'],
    ['sump', 4.1, 5.25, 1.55, 1.35, 'mixed', 'Flooded Sump'],
    ['bridge', 5.85, 3.25, 1.6, 1.55, 'combat', 'Timber Bridge'],
    ['cache', 7.45, 1.25, 1.45, 1.3, 'treasure', 'Survey Cache'],
    ['vault', 8.25, 4.25, 2.05, 2.0, 'guardian', 'Guardian Vault']
  ]),
  Object.freeze([
    ['lift', 0.75, 3.15, 1.45, 1.45, 'start', 'Lift Station'],
    ['shaft', 2.55, 3.15, 1.6, 1.55, 'combat', 'Split Shaft'],
    ['vein', 4.35, 3.15, 1.6, 1.55, 'mining', 'Golden Vein'],
    ['cache', 4.35, 5.25, 1.45, 1.3, 'treasure', 'Foreman Cache'],
    ['nest', 6.1, 1.2, 1.55, 1.35, 'combat', 'Crawler Nest'],
    ['works', 6.1, 4.1, 1.65, 1.55, 'mixed', 'Crystal Works'],
    ['vault', 8.35, 3.05, 2.05, 2.0, 'guardian', 'Guardian Vault']
  ])
]);

const ROOM_TEMPLATES_V2 = Object.freeze([
  Object.freeze([
    ['lift', 0.9, 3.5, 1.45, 1.45, 'start', 'Lift Station'],
    ['vein-a', 2.8, 3.5, 1.65, 1.55, 'mining', 'Shimmering Vein'],
    ['crossing', 4.85, 3.5, 1.7, 1.65, 'mixed', 'Broken Crossing'],
    ['cache', 4.85, 1.2, 1.55, 1.3, 'treasure', 'Prospector Cache'],
    ['works', 6.95, 3.5, 1.7, 1.65, 'combat', 'Old Workings'],
    ['deep-vein', 6.95, 5.8, 1.6, 1.35, 'mining', 'Deep Vein'],
    ['vault', 9.8, 3.5, 2.8, 2.6, 'guardian', 'Guardian Vault']
  ]),
  Object.freeze([
    ['lift', 0.9, 3.5, 1.45, 1.45, 'start', 'Lift Station'],
    ['fork', 2.8, 3.5, 1.65, 1.55, 'mixed', 'Collapsed Fork'],
    ['upper', 2.8, 1.1, 1.55, 1.35, 'combat', 'Bat Gallery'],
    ['lower', 2.8, 5.9, 1.55, 1.35, 'mining', 'Copper Shelf'],
    ['relay', 5.2, 3.5, 1.7, 1.65, 'combat', 'Dust Relay'],
    ['cache', 5.2, 5.9, 1.55, 1.35, 'treasure', 'Lost Cache'],
    ['vault', 8.2, 3.5, 2.8, 2.6, 'guardian', 'Guardian Vault']
  ]),
  Object.freeze([
    ['lift', 0.9, 3.5, 1.45, 1.45, 'start', 'Lift Station'],
    ['gallery', 2.8, 3.5, 1.55, 1.55, 'mining', 'Crystal Gallery'],
    ['rise', 2.8, 1.1, 1.45, 1.3, 'combat', 'Exploder Rise'],
    ['sump', 2.8, 5.9, 1.55, 1.35, 'mixed', 'Flooded Sump'],
    ['bridge', 5.2, 3.5, 1.6, 1.55, 'combat', 'Timber Bridge'],
    ['cache', 5.2, 1.1, 1.45, 1.3, 'treasure', 'Survey Cache'],
    ['vault', 8.2, 3.5, 2.8, 2.6, 'guardian', 'Guardian Vault']
  ]),
  Object.freeze([
    ['lift', 0.9, 3.5, 1.45, 1.45, 'start', 'Lift Station'],
    ['shaft', 2.8, 3.5, 1.6, 1.55, 'combat', 'Split Shaft'],
    ['vein', 4.9, 3.5, 1.6, 1.55, 'mining', 'Golden Vein'],
    ['cache', 4.9, 5.9, 1.45, 1.3, 'treasure', 'Foreman Cache'],
    ['nest', 7.0, 1.1, 1.55, 1.35, 'combat', 'Crawler Nest'],
    ['works', 7.0, 3.5, 1.65, 1.55, 'mixed', 'Crystal Works'],
    ['vault', 9.8, 3.5, 2.8, 2.6, 'guardian', 'Guardian Vault']
  ])
]);

const LEGACY_TEMPLATE_LINKS_V1 = Object.freeze([
  Object.freeze([['lift', 'vein-a'], ['vein-a', 'crossing'], ['crossing', 'cache'], ['crossing', 'works'], ['works', 'deep-vein'], ['works', 'vault']]),
  Object.freeze([['lift', 'fork'], ['fork', 'upper'], ['fork', 'lower'], ['upper', 'relay'], ['lower', 'relay'], ['relay', 'cache'], ['relay', 'vault']]),
  Object.freeze([['lift', 'gallery'], ['gallery', 'rise'], ['gallery', 'sump'], ['rise', 'bridge'], ['sump', 'bridge'], ['bridge', 'cache'], ['bridge', 'vault']]),
  Object.freeze([['lift', 'shaft'], ['shaft', 'vein'], ['vein', 'cache'], ['vein', 'nest'], ['vein', 'works'], ['nest', 'vault'], ['works', 'vault']])
]);

const TEMPLATE_LINKS_V2 = Object.freeze([
  Object.freeze([['lift', 'vein-a'], ['vein-a', 'crossing'], ['crossing', 'cache'], ['crossing', 'works'], ['works', 'deep-vein'], ['works', 'vault']]),
  Object.freeze([['lift', 'fork'], ['fork', 'upper'], ['fork', 'lower'], ['fork', 'relay'], ['relay', 'cache'], ['relay', 'vault']]),
  Object.freeze([['lift', 'gallery'], ['gallery', 'rise'], ['gallery', 'sump'], ['gallery', 'bridge'], ['rise', 'cache'], ['bridge', 'vault']]),
  Object.freeze([['lift', 'shaft'], ['shaft', 'vein'], ['vein', 'cache'], ['vein', 'works'], ['works', 'nest'], ['works', 'vault']])
]);

export function defaultEndlessConfig() {
  return {
    schemaVersion: ENDLESS_CONFIG_VERSION,
    generatorVersion: ENDLESS_GENERATOR_VERSION,
    enabled: true,
    nftRequired: true,
    entry: {
      paidEnabled: false,
      mattPrice: 0,
      entriesPerWallet: 0,
      entriesPerMiner: 0,
      resetPeriodHours: 24,
      resetUtcHour: 0,
      cooldownSeconds: 0,
      maximumActiveRunsPerWallet: 1,
      minimumMinerLevel: 1,
      abandonedRunsConsumeEntry: true
    },
    scoring: {
      basePhasePoints: 5_000,
      pointsPerGrowthStep: 500,
      phasesPerGrowthStep: 5,
      maximumPhasePoints: 50_000,
      completionShareBps: 1_000,
      bossShareBps: 2_000
    },
    difficulty: {
      baseBudget: 100,
      growthPerPhase: 7,
      growthCurve: 0.72,
      maximumBudget: 10_000,
      guardianHealthScale: 0.6,
      guardianDamageScale: 0.75,
      healthScalePerTier: 0.08,
      damageScalePerTier: 0.055,
      speedScalePerTier: 0.018,
      maximumStatScale: 8,
      milestoneEvery: 5,
      modifierEvery: 3
    },
    generation: {
      minimumRooms: 7,
      maximumRooms: 7,
      baseNaturalEnemies: 10,
      maximumNaturalEnemies: 64,
      baseOreObjects: 14,
      maximumOreObjects: 48,
      maximumHazards: 10,
      maximumObjects: 180,
      crystalObjectsPerPhase: 3,
      guardianRoomWidth: 2.8,
      guardianRoomHeight: 2.6,
      corridorWidthMinimum: 0.66,
      corridorWidthMaximum: 0.83,
      safeStartSeconds: 4
    },
    rewards: {
      enabled: true,
      crystalsEnabled: true,
      minerXpEnabled: true,
      // Conversion and XP come from a published economy version. A generated
      // map never invents token amounts.
      economyVersion: '',
      crystalConversionNumerator: 0,
      crystalConversionDenominator: 1,
      mineableCrystalUnits: 0,
      maximumPayoutNumerator: 0,
      maximumPayoutDenominator: 1,
      maximumDailyPayoutNumerator: 0,
      maximumDailyPayoutDenominator: 1,
      maximumPhases: ENDLESS_MAX_PHASE,
      phaseXp: 0,
      maximumRunXp: 0,
      maximumWalletXpPerDay: 0,
      maximumMinerXpPerDay: 0,
      checkpointTimeoutSeconds: 86_400,
      failedRunsRetainXp: false
    },
    integrity: {
      checkpointEveryPhases: 1,
      heartbeatSeconds: 30,
      missedHeartbeatTolerance: 8,
      reconnectWindowSeconds: 86_400,
      maximumReconnectsPerRun: 100,
      maximumReconnectsPerPhase: 8,
      maximumEventsPerPhase: 20_000,
      maximumInputEventsPerPhase: 750_000,
      inputClockToleranceSeconds: 10,
      maximumPhaseSeconds: 14_400
    },
    leaderboards: {
      daily: true,
      weekly: true,
      season: true,
      allTime: true,
      seasonDays: 30
    },
    smartEngine: {
      enabled: true,
      targetClearSeconds: 420,
      maximumAdjustmentBps: 1_500,
      minimumSamples: 25
    }
  };
}

export function normalizeEndlessConfig(input = {}) {
  const defaults = defaultEndlessConfig();
  const source = isRecord(input) ? input : {};
  const config = {
    schemaVersion: ENDLESS_CONFIG_VERSION,
    generatorVersion: cleanVersion(source.generatorVersion || defaults.generatorVersion),
    enabled: source.enabled !== false,
    nftRequired: true,
    entry: {
      paidEnabled: source.entry?.paidEnabled === true,
      mattPrice: integer(source.entry?.mattPrice, ENDLESS_ENTRY_PRICE_MIN, ENDLESS_ENTRY_PRICE_MAX, 0),
      entriesPerWallet: integer(source.entry?.entriesPerWallet, 0, 1_000_000, defaults.entry.entriesPerWallet),
      entriesPerMiner: integer(source.entry?.entriesPerMiner, 0, 1_000_000, defaults.entry.entriesPerMiner),
      resetPeriodHours: integer(source.entry?.resetPeriodHours, 1, 8_760, defaults.entry.resetPeriodHours),
      resetUtcHour: integer(source.entry?.resetUtcHour, 0, 23, defaults.entry.resetUtcHour),
      cooldownSeconds: integer(source.entry?.cooldownSeconds, 0, 604_800, defaults.entry.cooldownSeconds),
      maximumActiveRunsPerWallet: integer(source.entry?.maximumActiveRunsPerWallet, 1, 100, defaults.entry.maximumActiveRunsPerWallet),
      minimumMinerLevel: integer(source.entry?.minimumMinerLevel, 1, 1_000, defaults.entry.minimumMinerLevel),
      abandonedRunsConsumeEntry: source.entry?.abandonedRunsConsumeEntry !== false
    },
    scoring: {
      basePhasePoints: integer(source.scoring?.basePhasePoints, 100, 10_000_000, defaults.scoring.basePhasePoints),
      pointsPerGrowthStep: integer(source.scoring?.pointsPerGrowthStep, 0, 1_000_000, defaults.scoring.pointsPerGrowthStep),
      phasesPerGrowthStep: integer(source.scoring?.phasesPerGrowthStep, 1, 10_000, defaults.scoring.phasesPerGrowthStep),
      maximumPhasePoints: integer(source.scoring?.maximumPhasePoints, 100, 100_000_000, defaults.scoring.maximumPhasePoints),
      completionShareBps: integer(source.scoring?.completionShareBps, 0, 8_000, defaults.scoring.completionShareBps),
      bossShareBps: integer(source.scoring?.bossShareBps, 0, 8_000, defaults.scoring.bossShareBps)
    },
    difficulty: {
      baseBudget: number(source.difficulty?.baseBudget, 1, 1_000_000, defaults.difficulty.baseBudget),
      growthPerPhase: number(source.difficulty?.growthPerPhase, 0, 100_000, defaults.difficulty.growthPerPhase),
      growthCurve: number(source.difficulty?.growthCurve, 0.1, 2, defaults.difficulty.growthCurve),
      maximumBudget: number(source.difficulty?.maximumBudget, 1, 100_000_000, defaults.difficulty.maximumBudget),
      guardianHealthScale: number(source.difficulty?.guardianHealthScale, 0.1, 3, defaults.difficulty.guardianHealthScale),
      guardianDamageScale: number(source.difficulty?.guardianDamageScale, 0.1, 3, defaults.difficulty.guardianDamageScale),
      healthScalePerTier: number(source.difficulty?.healthScalePerTier, 0, 1, defaults.difficulty.healthScalePerTier),
      damageScalePerTier: number(source.difficulty?.damageScalePerTier, 0, 1, defaults.difficulty.damageScalePerTier),
      speedScalePerTier: number(source.difficulty?.speedScalePerTier, 0, 0.25, defaults.difficulty.speedScalePerTier),
      maximumStatScale: number(source.difficulty?.maximumStatScale, 1, 100, defaults.difficulty.maximumStatScale),
      milestoneEvery: integer(source.difficulty?.milestoneEvery, 1, 10_000, defaults.difficulty.milestoneEvery),
      modifierEvery: integer(source.difficulty?.modifierEvery, 1, 10_000, defaults.difficulty.modifierEvery)
    },
    generation: {
      minimumRooms: integer(source.generation?.minimumRooms, 7, 7, defaults.generation.minimumRooms),
      maximumRooms: integer(source.generation?.maximumRooms, 7, 7, defaults.generation.maximumRooms),
      baseNaturalEnemies: integer(source.generation?.baseNaturalEnemies, 1, 64, defaults.generation.baseNaturalEnemies),
      maximumNaturalEnemies: integer(source.generation?.maximumNaturalEnemies, 1, 96, defaults.generation.maximumNaturalEnemies),
      baseOreObjects: integer(source.generation?.baseOreObjects, 4, 64, defaults.generation.baseOreObjects),
      maximumOreObjects: integer(source.generation?.maximumOreObjects, 4, 96, defaults.generation.maximumOreObjects),
      maximumHazards: integer(source.generation?.maximumHazards, 0, 24, defaults.generation.maximumHazards),
      maximumObjects: integer(source.generation?.maximumObjects, 32, 300, defaults.generation.maximumObjects),
      crystalObjectsPerPhase: integer(source.generation?.crystalObjectsPerPhase, 1, 20, defaults.generation.crystalObjectsPerPhase),
      guardianRoomWidth: number(source.generation?.guardianRoomWidth, 2.2, 3.5, defaults.generation.guardianRoomWidth),
      guardianRoomHeight: number(source.generation?.guardianRoomHeight, 2, 3, defaults.generation.guardianRoomHeight),
      corridorWidthMinimum: number(source.generation?.corridorWidthMinimum, 0.3, 2, defaults.generation.corridorWidthMinimum),
      corridorWidthMaximum: number(source.generation?.corridorWidthMaximum, 0.3, 2, defaults.generation.corridorWidthMaximum),
      safeStartSeconds: number(source.generation?.safeStartSeconds, 0, 30, defaults.generation.safeStartSeconds)
    },
    rewards: {
      enabled: source.rewards?.enabled !== false,
      crystalsEnabled: source.rewards?.crystalsEnabled !== false,
      minerXpEnabled: source.rewards?.minerXpEnabled !== false,
      economyVersion: cleanVersion(source.rewards?.economyVersion || ''),
      crystalConversionNumerator: integer(source.rewards?.crystalConversionNumerator, 0, Number.MAX_SAFE_INTEGER, 0),
      crystalConversionDenominator: integer(source.rewards?.crystalConversionDenominator, 1, 1_000_000_000, 1),
      mineableCrystalUnits: integer(source.rewards?.mineableCrystalUnits, 0, 1_000_000_000, 0),
      maximumPayoutNumerator: integer(source.rewards?.maximumPayoutNumerator, 0, Number.MAX_SAFE_INTEGER, 0),
      maximumPayoutDenominator: integer(source.rewards?.maximumPayoutDenominator, 1, 1_000_000_000, 1),
      maximumDailyPayoutNumerator: integer(source.rewards?.maximumDailyPayoutNumerator, 0, Number.MAX_SAFE_INTEGER, 0),
      maximumDailyPayoutDenominator: integer(source.rewards?.maximumDailyPayoutDenominator, 1, 1_000_000_000, 1),
      maximumPhases: integer(source.rewards?.maximumPhases, 1, ENDLESS_MAX_PHASE, ENDLESS_MAX_PHASE),
      phaseXp: integer(source.rewards?.phaseXp, 0, 1_000_000, 0),
      maximumRunXp: integer(source.rewards?.maximumRunXp, 0, 1_000_000, 0),
      maximumWalletXpPerDay: integer(source.rewards?.maximumWalletXpPerDay, 0, 1_000_000, 0),
      maximumMinerXpPerDay: integer(source.rewards?.maximumMinerXpPerDay, 0, 1_000_000, 0),
      checkpointTimeoutSeconds: integer(source.rewards?.checkpointTimeoutSeconds, 300, 604_800, 86_400),
      failedRunsRetainXp: source.rewards?.failedRunsRetainXp === true
    },
    integrity: {
      checkpointEveryPhases: 1,
      heartbeatSeconds: integer(source.integrity?.heartbeatSeconds, 10, 300, defaults.integrity.heartbeatSeconds),
      missedHeartbeatTolerance: integer(source.integrity?.missedHeartbeatTolerance, 0, 1_000, defaults.integrity.missedHeartbeatTolerance),
      reconnectWindowSeconds: integer(source.integrity?.reconnectWindowSeconds, 60, 604_800, defaults.integrity.reconnectWindowSeconds),
      maximumReconnectsPerRun: integer(source.integrity?.maximumReconnectsPerRun, 0, 10_000, defaults.integrity.maximumReconnectsPerRun),
      maximumReconnectsPerPhase: integer(source.integrity?.maximumReconnectsPerPhase, 0, 1_000, defaults.integrity.maximumReconnectsPerPhase),
      maximumEventsPerPhase: integer(source.integrity?.maximumEventsPerPhase, 100, 100_000, defaults.integrity.maximumEventsPerPhase),
      maximumInputEventsPerPhase: integer(source.integrity?.maximumInputEventsPerPhase, 100, 1_000_000, defaults.integrity.maximumInputEventsPerPhase),
      inputClockToleranceSeconds: integer(source.integrity?.inputClockToleranceSeconds, 1, 60, defaults.integrity.inputClockToleranceSeconds),
      maximumPhaseSeconds: integer(source.integrity?.maximumPhaseSeconds, 60, 86_400, defaults.integrity.maximumPhaseSeconds)
    },
    leaderboards: {
      daily: source.leaderboards?.daily !== false,
      weekly: source.leaderboards?.weekly !== false,
      season: source.leaderboards?.season !== false,
      allTime: source.leaderboards?.allTime !== false,
      seasonDays: integer(source.leaderboards?.seasonDays, 1, 365, defaults.leaderboards.seasonDays)
    },
    smartEngine: {
      enabled: source.smartEngine?.enabled !== false,
      targetClearSeconds: integer(source.smartEngine?.targetClearSeconds, 30, 7_200, defaults.smartEngine.targetClearSeconds),
      maximumAdjustmentBps: integer(source.smartEngine?.maximumAdjustmentBps, 0, 5_000, defaults.smartEngine.maximumAdjustmentBps),
      minimumSamples: integer(source.smartEngine?.minimumSamples, 5, 10_000, defaults.smartEngine.minimumSamples)
    }
  };
  if (config.scoring.maximumPhasePoints < config.scoring.basePhasePoints) {
    config.scoring.maximumPhasePoints = config.scoring.basePhasePoints;
  }
  if (config.generation.maximumNaturalEnemies < config.generation.baseNaturalEnemies) {
    config.generation.maximumNaturalEnemies = config.generation.baseNaturalEnemies;
  }
  if (config.generation.maximumOreObjects < config.generation.baseOreObjects) {
    config.generation.maximumOreObjects = config.generation.baseOreObjects;
  }
  if (config.generation.corridorWidthMaximum < config.generation.corridorWidthMinimum) {
    config.generation.corridorWidthMaximum = config.generation.corridorWidthMinimum;
  }
  return config;
}

export function validateEndlessConfig(input, { forActivation = false } = {}) {
  const config = normalizeEndlessConfig(input);
  const errors = [];
  const requestedMattPrice = Number(input?.entry?.mattPrice);
  if (!ENDLESS_SUPPORTED_GENERATOR_VERSIONS.includes(config.generatorVersion)) {
    errors.push(`Generator version must be one of: ${ENDLESS_SUPPORTED_GENERATOR_VERSIONS.join(', ')}.`);
  }
  if (input?.entry?.mattPrice !== undefined && (!Number.isFinite(requestedMattPrice) || requestedMattPrice < ENDLESS_ENTRY_PRICE_MIN || requestedMattPrice > ENDLESS_ENTRY_PRICE_MAX)) {
    errors.push(`MATT entry price must be between ${ENDLESS_ENTRY_PRICE_MIN} and ${ENDLESS_ENTRY_PRICE_MAX}.`);
  }
  validateRequestedInteger(errors, input?.entry, 'entriesPerWallet', 0, 1_000_000, 'Entries per wallet');
  validateRequestedInteger(errors, input?.entry, 'entriesPerMiner', 0, 1_000_000, 'Entries per Miner');
  validateRequestedInteger(errors, input?.entry, 'resetPeriodHours', 1, 8_760, 'Entry reset period hours');
  validateRequestedInteger(errors, input?.entry, 'resetUtcHour', 0, 23, 'Entry reset UTC hour');
  validateRequestedInteger(errors, input?.entry, 'cooldownSeconds', 0, 604_800, 'Entry cooldown seconds');
  validateRequestedInteger(errors, input?.entry, 'maximumActiveRunsPerWallet', 1, 100, 'Maximum active runs per wallet');
  validateRequestedInteger(errors, input?.entry, 'minimumMinerLevel', 1, 1_000, 'Minimum Miner level');
  validateRequestedInteger(errors, input?.integrity, 'heartbeatSeconds', 10, 300, 'Heartbeat seconds');
  validateRequestedInteger(errors, input?.integrity, 'missedHeartbeatTolerance', 0, 1_000, 'Missed heartbeat tolerance');
  validateRequestedInteger(errors, input?.integrity, 'reconnectWindowSeconds', 60, 604_800, 'Reconnect window seconds');
  validateRequestedInteger(errors, input?.integrity, 'maximumReconnectsPerRun', 0, 10_000, 'Maximum reconnects per run');
  validateRequestedInteger(errors, input?.integrity, 'maximumReconnectsPerPhase', 0, 1_000, 'Maximum reconnects per phase');
  validateRequestedInteger(errors, input?.integrity, 'maximumEventsPerPhase', 100, 100_000, 'Maximum outcome events per phase');
  validateRequestedInteger(errors, input?.integrity, 'maximumInputEventsPerPhase', 100, 1_000_000, 'Maximum input events per phase');
  validateRequestedInteger(errors, input?.integrity, 'inputClockToleranceSeconds', 1, 60, 'Input clock tolerance seconds');
  validateRequestedInteger(errors, input?.integrity, 'maximumPhaseSeconds', 60, 86_400, 'Maximum phase seconds');
  if (config.scoring.completionShareBps + config.scoring.bossShareBps > 9_000) {
    errors.push('Completion and Guardian point shares must leave at least 10% for the natural map.');
  }
  if (config.generation.maximumObjects < config.generation.maximumNaturalEnemies + config.generation.crystalObjectsPerPhase + 4) {
    errors.push('Maximum objects cannot contain the configured enemy and crystal limits.');
  }
  if (
    input?.generation?.corridorWidthMaximum !== undefined &&
    Number(input.generation.corridorWidthMaximum) < Number(input.generation.corridorWidthMinimum)
  ) {
    errors.push('Maximum corridor width must be greater than or equal to minimum corridor width.');
  }
  if (config.entry.paidEnabled && config.entry.mattPrice <= 0) {
    errors.push('Paid entry requires a positive published MATT price.');
  }
  if (!config.entry.paidEnabled && config.entry.mattPrice !== 0) {
    errors.push('MATT entry price must be zero while paid entry is disabled.');
  }
  if (forActivation && config.rewards.enabled && !config.rewards.economyVersion) {
    errors.push('A published economy version is required before Endless rewards can be activated.');
  }
  if (forActivation && config.rewards.enabled && (!config.rewards.crystalsEnabled || !config.rewards.minerXpEnabled)) {
    errors.push('The compact Endless settlement requires both CRYSTALS and Miner XP, or reward settlement must be disabled entirely.');
  }
  if (forActivation && config.rewards.crystalsEnabled && config.rewards.crystalConversionNumerator <= 0) {
    errors.push('A positive CRYSTALS conversion is required before crystal rewards can be activated.');
  }
  if (forActivation && config.rewards.crystalsEnabled && rationalGreaterThan(
    config.rewards.crystalConversionNumerator,
    config.rewards.crystalConversionDenominator,
    100_000,
    1
  )) {
    errors.push('CRYSTALS conversion cannot exceed the permanent 100,000-token contract ceiling.');
  }
  if (forActivation && config.rewards.crystalsEnabled && config.rewards.mineableCrystalUnits <= 0) {
    errors.push('A positive run Crystal-unit ceiling is required before crystal rewards can be activated.');
  }
  if (forActivation && config.rewards.crystalsEnabled && config.rewards.maximumPayoutNumerator <= 0) {
    errors.push('A positive per-run CRYSTALS payout ceiling is required before crystal rewards can be activated.');
  }
  if (forActivation && config.rewards.crystalsEnabled && rationalGreaterThan(
    config.rewards.maximumPayoutNumerator,
    config.rewards.maximumPayoutDenominator,
    100_000,
    1
  )) {
    errors.push('Per-run CRYSTALS payout cannot exceed the permanent 100,000-token contract ceiling.');
  }
  if (forActivation && config.rewards.crystalsEnabled && config.rewards.maximumDailyPayoutNumerator <= 0) {
    errors.push('A positive daily Endless CRYSTALS ceiling is required before crystal rewards can be activated.');
  }
  if (forActivation && config.rewards.crystalsEnabled && rationalGreaterThan(
    config.rewards.maximumDailyPayoutNumerator,
    config.rewards.maximumDailyPayoutDenominator,
    10_000_000,
    1
  )) {
    errors.push('Daily Endless CRYSTALS cannot exceed the permanent 10,000,000-token contract ceiling.');
  }
  if (forActivation && config.rewards.crystalsEnabled && rationalGreaterThan(
    config.rewards.maximumPayoutNumerator,
    config.rewards.maximumPayoutDenominator,
    config.rewards.maximumDailyPayoutNumerator,
    config.rewards.maximumDailyPayoutDenominator
  )) {
    errors.push('The daily Endless CRYSTALS ceiling cannot be lower than the per-run payout ceiling.');
  }
  if (forActivation && config.rewards.minerXpEnabled && config.rewards.phaseXp <= 0) {
    errors.push('A positive Miner XP award is required before XP rewards can be activated.');
  }
  if (forActivation && config.rewards.minerXpEnabled && config.rewards.maximumRunXp < config.rewards.phaseXp) {
    errors.push('Maximum Miner XP per run must be at least one phase award.');
  }
  if (forActivation && config.rewards.minerXpEnabled && config.rewards.maximumWalletXpPerDay <= 0) {
    errors.push('A positive wallet daily Miner XP ceiling is required before XP rewards can be activated.');
  }
  if (forActivation && config.rewards.minerXpEnabled && config.rewards.maximumMinerXpPerDay <= 0) {
    errors.push('A positive Miner NFT daily XP ceiling is required before XP rewards can be activated.');
  }
  return { ok: errors.length === 0, errors, config };
}

function validateRequestedInteger(errors, source, key, minimum, maximum, label) {
  if (source?.[key] === undefined) return;
  const value = Number(source[key]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    errors.push(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
}

function rationalGreaterThan(leftNumerator, leftDenominator, rightNumerator, rightDenominator) {
  return BigInt(leftNumerator) * BigInt(rightDenominator) > BigInt(rightNumerator) * BigInt(leftDenominator);
}

export function endlessPhaseSeed({ runId, runSeed, phase, configVersion, generatorVersion = ENDLESS_GENERATOR_VERSION }) {
  const normalizedPhase = integer(phase, 1, ENDLESS_MAX_PHASE, 1);
  return `${cleanVersion(generatorVersion)}:${cleanSeed(runId)}:${cleanSeed(runSeed)}:${integer(configVersion, 1, 1_000_000_000, 1)}:${normalizedPhase}`;
}

export function endlessPhasePointBudget(phase, configInput = {}) {
  const config = normalizeEndlessConfig(configInput);
  const value = config.scoring.basePhasePoints +
    Math.floor((integer(phase, 1, ENDLESS_MAX_PHASE, 1) - 1) / config.scoring.phasesPerGrowthStep) *
    config.scoring.pointsPerGrowthStep;
  return Math.min(config.scoring.maximumPhasePoints, value);
}

export function endlessDifficultyBudget(phase, configInput = {}) {
  const config = normalizeEndlessConfig(configInput);
  const depth = integer(phase, 1, ENDLESS_MAX_PHASE, 1) - 1;
  return Math.min(
    config.difficulty.maximumBudget,
    round(config.difficulty.baseBudget + config.difficulty.growthPerPhase * Math.pow(depth, config.difficulty.growthCurve), 3)
  );
}

export function calculateMinerCapability(profile = {}) {
  const traits = profile?.traits || {};
  const progression = profile?.progression || {};
  const equipment = profile?.equipment || profile?.loadout || {};
  const stats = profile?.stats || traits?.stats || {};
  const level = number(traits.level ?? progression.level, 1, 1_000_000, 1);
  const health = number(stats.health ?? traits.health, 1, 100_000, 100);
  const damage = number(stats.damage ?? traits.damage, 0, 100_000, 10);
  const armor = number(stats.armor ?? traits.armor, 0, 100_000, 0);
  const speed = number(stats.speed ?? traits.speed, 0, 1_000, 1);
  const luck = number(stats.luck ?? traits.luck, 0, 1_000, 1);
  const carry = number(
    stats.crystalCarryCapacity ?? traits.crystalCarryCapacity ?? profile?.crystalCarryCapacity,
    0,
    1_000_000,
    0
  );
  const equipmentScore = Object.values(isRecord(equipment) ? equipment : {}).reduce((sum, item) => {
    if (!isRecord(item)) return sum;
    return sum + number(item.power ?? item.rating ?? item.level, 0, 100_000, 0);
  }, 0);
  const components = {
    level: round(level * 8, 3),
    survivability: round(health * 0.22 + armor * 1.6, 3),
    offense: round(damage * 2.5, 3),
    mobility: round(speed * 12, 3),
    utility: round(luck * 4 + Math.sqrt(carry) * 2, 3),
    equipment: round(equipmentScore * 0.8, 3)
  };
  return {
    rating: Math.max(1, round(Object.values(components).reduce((sum, value) => sum + value, 0), 3)),
    components,
    snapshot: { level, health, damage, armor, speed, luck, crystalCarryCapacity: carry }
  };
}

export function calculateDangerRating(difficultyBudget, capabilityInput) {
  const capability = typeof capabilityInput === 'number'
    ? Math.max(1, capabilityInput)
    : Math.max(1, Number(capabilityInput?.rating) || 1);
  const ratio = Math.max(0, Number(difficultyBudget) || 0) / capability;
  const tier = ratio < 0.55 ? 'LOW' : ratio < 0.9 ? 'GUARDED' : ratio < 1.25 ? 'HIGH' : ratio < 1.75 ? 'SEVERE' : 'EXTREME';
  return { ratio: round(ratio, 3), tier };
}

export function generateEndlessPhase(options = {}) {
  const phase = integer(options.phase, 1, ENDLESS_MAX_PHASE, 1);
  const config = normalizeEndlessConfig(options.config);
  const configVersion = integer(options.configVersion, 1, 1_000_000_000, 1);
  const seed = endlessPhaseSeed({
    runId: options.runId,
    runSeed: options.runSeed,
    phase,
    configVersion,
    generatorVersion: config.generatorVersion
  });
  const random = createSeededRandom(seed);
  const templates = endlessTemplateSet(config.generatorVersion);
  const templateIndex = Math.floor(random() * templates.rooms.length);
  const rooms = templates.rooms[templateIndex].map((entry) => ({
    id: entry[0], x: entry[1], y: entry[2], width: entry[3], height: entry[4], type: entry[5], name: entry[6]
  }));
  if (config.generatorVersion === ENDLESS_GENERATOR_VERSION) {
    const guardianRoom = rooms.find((room) => room.type === 'guardian');
    guardianRoom.width = config.generation.guardianRoomWidth;
    guardianRoom.height = config.generation.guardianRoomHeight;
  }
  const corridors = templates.links[templateIndex].map(([from, to], index) => ({
    id: `path-${index + 1}`,
    from,
    to,
    width: round(
      config.generation.corridorWidthMinimum +
      random() * (config.generation.corridorWidthMaximum - config.generation.corridorWidthMinimum),
      3
    )
  }));
  const combatRooms = rooms.filter((room) => !['start', 'guardian'].includes(room.type));
  const oreRooms = rooms.filter((room) => ['mining', 'mixed', 'treasure'].includes(room.type));
  const difficultyBudget = endlessDifficultyBudget(phase, config);
  const tier = Math.floor((phase - 1) / config.difficulty.milestoneEvery);
  const enemyCount = Math.min(
    config.generation.maximumNaturalEnemies,
    config.generation.baseNaturalEnemies + Math.floor(Math.sqrt(phase - 1) * 1.6)
  );
  const oreCount = Math.min(
    config.generation.maximumOreObjects,
    config.generation.baseOreObjects + Math.floor(Math.log2(Math.max(1, phase)))
  );
  const hazardCount = Math.min(config.generation.maximumHazards, Math.floor((phase - 1) / 3));
  const pointBudget = endlessPhasePointBudget(phase, config);
  const completionPoints = Math.floor(pointBudget * config.scoring.completionShareBps / 10_000);
  const bossPoints = Math.floor(pointBudget * config.scoring.bossShareBps / 10_000);
  const naturalPointBudget = pointBudget - completionPoints - bossPoints;
  const naturalWeights = [
    ...Array.from({ length: enemyCount }, (_, index) => 5 + (index % 5) * 2),
    ...Array.from({ length: oreCount }, (_, index) => 3 + (index % 4))
  ];
  const pointValues = solveExactIntegerBudget(naturalPointBudget, naturalWeights);
  const objects = [
    placedObject('spawn-player', 'player', 'lift', -0.15, 0),
    placedObject('extract-lift', 'extraction', 'lift', 0.23, 0)
  ];
  let pointIndex = 0;
  const requiredEnemyIds = [];
  for (let index = 0; index < enemyCount; index += 1) {
    const room = combatRooms[index % combatRooms.length];
    const type = enemyTypeForPhase(phase, index, random);
    const id = `enemy-${phase}-${index + 1}`;
    requiredEnemyIds.push(id);
    objects.push(placedObject(
      id,
      type,
      room.id,
      position(random, index, 0.34),
      position(random, index + 11, 0.3),
      1,
      { classification: 'natural', requiredForBoss: true, points: pointValues[pointIndex++] }
    ));
  }
  for (let index = 0; index < oreCount; index += 1) {
    const room = oreRooms[index % oreRooms.length];
    const isCrystal = index < config.generation.crystalObjectsPerPhase;
    const type = isCrystal ? 'crystal' : oreTypeForIndex(index, random);
    objects.push(placedObject(
      `ore-${phase}-${index + 1}`,
      type,
      room.id,
      position(random, index + 23, 0.36),
      position(random, index + 37, 0.32),
      1,
      { classification: 'ore', points: pointValues[pointIndex++], mattCrystal: isCrystal }
    ));
  }
  for (let index = 0; index < hazardCount; index += 1) {
    const room = combatRooms[(index * 3 + 1) % combatRooms.length];
    objects.push(placedObject(
      `hazard-${phase}-${index + 1}`,
      ENDLESS_HAZARD_TYPES[(index + templateIndex) % ENDLESS_HAZARD_TYPES.length],
      room.id,
      position(random, index + 51, 0.3),
      position(random, index + 67, 0.28),
      1,
      { classification: 'hazard', points: 0 }
    ));
  }
  objects.push(placedObject('guardian-phase', 'guardian', 'vault', 0, 0, 1, {
    classification: 'boss', requiredForBoss: false, points: bossPoints
  }));

  const statScale = {
    health: round(Math.min(config.difficulty.maximumStatScale, 1 + tier * config.difficulty.healthScalePerTier), 4),
    damage: round(Math.min(config.difficulty.maximumStatScale, 1 + tier * config.difficulty.damageScalePerTier), 4),
    speed: round(Math.min(config.difficulty.maximumStatScale, 1 + tier * config.difficulty.speedScalePerTier), 4)
  };
  const guardianStatScale = {
    health: config.difficulty.guardianHealthScale,
    damage: config.difficulty.guardianDamageScale
  };
  const capability = calculateMinerCapability(options.minerProfile);
  const danger = calculateDangerRating(difficultyBudget, capability);
  const modifier = phase > 1 && phase % config.difficulty.modifierEvery === 0
    ? ['dense_veins', 'volatile_ground', 'armored_nest', 'swift_hunters'][Math.floor(random() * 4)]
    : '';
  const milestone = phase > 1 && phase % config.difficulty.milestoneEvery === 0;
  const map = {
    name: `MATT Mine Endless - Phase ${phase}`,
    background: ['deep', 'crystal', 'ruins', 'magma'][(templateIndex + tier) % 4],
    rooms,
    corridors,
    objects
  };
  const manifest = {
    schemaVersion: ENDLESS_CONFIG_VERSION,
    generatorVersion: config.generatorVersion,
    configVersion,
    phase,
    seed,
    fingerprint: '',
    map,
    pointBudget,
    pointLedger: {
      completion: completionPoints,
      boss: bossPoints,
      natural: naturalPointBudget,
      total: pointBudget
    },
    difficulty: {
      budget: difficultyBudget,
      tier,
      statScale,
      guardianStatScale,
      modifier,
      milestone
    },
    capability,
    danger,
    gate: {
      rule: 'all_required_natural_enemies',
      requiredEnemyIds,
      requiredCount: requiredEnemyIds.length,
      summonsRelock: false,
      crystalsUnlockBoss: false
    },
    rewards: {
      economyVersion: config.rewards.economyVersion,
      crystalObjects: config.generation.crystalObjectsPerPhase,
      crystalConversionNumerator: config.rewards.crystalConversionNumerator,
      crystalConversionDenominator: config.rewards.crystalConversionDenominator,
      phaseXp: config.rewards.phaseXp
    },
    rules: {
      safeStartSeconds: config.generation.safeStartSeconds,
      maximumEvents: config.integrity.maximumEventsPerPhase,
      maximumSeconds: config.integrity.maximumPhaseSeconds
    }
  };
  manifest.fingerprint = stableFingerprint(manifest);
  const validation = validateEndlessManifest(manifest, config);
  if (!validation.ok) throw new Error(`Invalid Endless phase: ${validation.errors.join(' ')}`);
  return manifest;
}

export function validateEndlessManifest(input, configInput = {}) {
  const config = normalizeEndlessConfig(configInput);
  const manifest = isRecord(input) ? input : {};
  const errors = [];
  const map = isRecord(manifest.map) ? manifest.map : {};
  const rooms = Array.isArray(map.rooms) ? map.rooms : [];
  const corridors = Array.isArray(map.corridors) ? map.corridors : [];
  const objects = Array.isArray(map.objects) ? map.objects : [];
  const roomIds = new Set(rooms.map((room) => room.id));
  const objectIds = new Set();
  if (manifest.generatorVersion !== config.generatorVersion) errors.push('Manifest generator version does not match its frozen configuration.');
  if (rooms.length < config.generation.minimumRooms || rooms.length > config.generation.maximumRooms) errors.push('Room count is outside configured bounds.');
  if (objects.length > config.generation.maximumObjects) errors.push('Object count exceeds the configured limit.');
  if (rooms.filter((room) => room.type === 'start').length !== 1) errors.push('Exactly one start room is required.');
  if (rooms.filter((room) => room.type === 'guardian').length !== 1) errors.push('Exactly one Guardian room is required.');
  for (const room of rooms) {
    if (!room?.id || roomIds.size !== rooms.length) errors.push('Room IDs must be unique.');
    if (![room.x, room.y, room.width, room.height].every(Number.isFinite)) errors.push(`Room ${room?.id || '?'} has invalid geometry.`);
    if (room.x < 0 || room.x > 11 || room.y < 0 || room.y > 7 || room.width < 1 || room.width > 3.5 || room.height < 1 || room.height > 3) {
      errors.push(`Room ${room?.id || '?'} is outside map bounds.`);
    }
  }
  for (let left = 0; left < rooms.length; left += 1) {
    for (let right = left + 1; right < rooms.length; right += 1) {
      if (roomsOverlap(rooms[left], rooms[right])) errors.push(`Rooms ${rooms[left].id} and ${rooms[right].id} overlap.`);
    }
  }
  for (const corridor of corridors) {
    if (!roomIds.has(corridor.from) || !roomIds.has(corridor.to) || corridor.from === corridor.to) errors.push(`Corridor ${corridor.id || '?'} has invalid endpoints.`);
    const from = rooms.find((room) => room.id === corridor.from);
    const to = rooms.find((room) => room.id === corridor.to);
    if (manifest.generatorVersion === ENDLESS_GENERATOR_VERSION && from && to && from.x !== to.x && from.y !== to.y) {
      errors.push(`Corridor ${corridor.id || '?'} must connect rooms on one exact shared X or Y doorway axis.`);
    }
  }
  if (!allRoomsReachable(rooms, corridors)) errors.push('Every room must be reachable from the Lift Station.');
  for (const object of objects) {
    if (!object?.id || objectIds.has(object.id)) errors.push('Object IDs must be present and unique.');
    objectIds.add(object?.id);
    if (!roomIds.has(object?.roomId)) errors.push(`Object ${object?.id || '?'} references an unknown room.`);
    if (!Number.isSafeInteger(object?.points) || object.points < 0) errors.push(`Object ${object?.id || '?'} has invalid points.`);
    if (!Number.isFinite(object?.x) || !Number.isFinite(object?.y) || Math.abs(object.x) > 0.48 || Math.abs(object.y) > 0.48) errors.push(`Object ${object?.id || '?'} is outside its room.`);
  }
  const requiredIds = Array.isArray(manifest.gate?.requiredEnemyIds) ? manifest.gate.requiredEnemyIds : [];
  const requiredObjects = objects.filter((object) => object.requiredForBoss === true && object.classification === 'natural');
  if (new Set(requiredIds).size !== requiredIds.length || requiredIds.some((id) => !objectIds.has(id))) errors.push('Boss gate references invalid required enemies.');
  if (requiredObjects.length !== requiredIds.length || requiredObjects.some((object) => !requiredIds.includes(object.id))) errors.push('Every natural required enemy must be represented exactly once in the boss gate.');
  if (manifest.gate?.crystalsUnlockBoss !== false || manifest.gate?.summonsRelock !== false) errors.push('Boss gate invariants are invalid.');
  const objectPoints = objects.reduce((sum, object) => sum + (Number.isSafeInteger(object.points) ? object.points : 0), 0);
  const collectibleMaximum = objectPoints + (Number.isSafeInteger(manifest.pointLedger?.completion) ? manifest.pointLedger.completion : 0);
  if (collectibleMaximum !== manifest.pointBudget) errors.push(`Collectible maximum ${collectibleMaximum} does not equal phase budget ${manifest.pointBudget}.`);
  if (manifest.pointBudget !== endlessPhasePointBudget(manifest.phase, config)) errors.push('Phase budget does not match its frozen configuration.');
  const fingerprint = String(manifest.fingerprint || '');
  if (fingerprint && fingerprint !== stableFingerprint({ ...manifest, fingerprint: '' })) errors.push('Manifest fingerprint does not match its contents.');
  return { ok: errors.length === 0, errors, collectibleMaximum };
}

export function solveExactIntegerBudget(total, weights) {
  const budget = integer(total, 0, Number.MAX_SAFE_INTEGER, 0);
  if (!Array.isArray(weights) || weights.length === 0) return budget === 0 ? [] : [budget];
  const normalized = weights.map((weight) => Math.max(1, Number(weight) || 1));
  const weightTotal = normalized.reduce((sum, weight) => sum + weight, 0);
  const values = normalized.map((weight) => Math.floor(budget * weight / weightTotal));
  let remainder = budget - values.reduce((sum, value) => sum + value, 0);
  const fractions = normalized
    .map((weight, index) => ({ index, fraction: budget * weight / weightTotal - values[index] }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (let index = 0; remainder > 0; index = (index + 1) % fractions.length) {
    values[fractions[index].index] += 1;
    remainder -= 1;
  }
  return values;
}

export function stableFingerprint(value) {
  const text = stableStringify(value);
  let high = 0x811c9dc5;
  let low = 0x9e3779b9;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    high = Math.imul(high ^ code, 0x01000193) >>> 0;
    low = Math.imul(low ^ (code + index), 0x85ebca6b) >>> 0;
  }
  return `${high.toString(16).padStart(8, '0')}${low.toString(16).padStart(8, '0')}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function placedObject(id, type, roomId, x, y, quantity = 1, metadata = {}) {
  return { id, type, roomId, x: round(x, 4), y: round(y, 4), quantity, points: 0, ...metadata };
}

function enemyTypeForPhase(phase, index, random) {
  const unlocked = Math.min(ENDLESS_ENEMY_TYPES.length, 2 + Math.floor((phase - 1) / 2));
  return ENDLESS_ENEMY_TYPES[(index + Math.floor(random() * unlocked)) % unlocked];
}

function oreTypeForIndex(index, random) {
  const values = ['stone', 'stone', 'copper', 'copper', 'gold'];
  return values[(index + Math.floor(random() * values.length)) % values.length];
}

function position(random, salt, spread) {
  const sign = salt % 2 === 0 ? 1 : -1;
  return sign * (0.08 + random() * spread);
}

function createSeededRandom(seed) {
  let state = hashSeed(String(seed || 'MATT-ENDLESS')) || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function endlessTemplateSet(generatorVersion) {
  if (generatorVersion === 'endless-map-v1') {
    return { rooms: LEGACY_ROOM_TEMPLATES_V1, links: LEGACY_TEMPLATE_LINKS_V1 };
  }
  if (generatorVersion === ENDLESS_GENERATOR_VERSION) {
    return { rooms: ROOM_TEMPLATES_V2, links: TEMPLATE_LINKS_V2 };
  }
  throw new TypeError(`Unsupported Endless generator version: ${generatorVersion}`);
}

function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return hash >>> 0;
}

function allRoomsReachable(rooms, corridors) {
  const start = rooms.find((room) => room.type === 'start');
  if (!start) return false;
  const reached = new Set([start.id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const corridor of corridors) {
      if (reached.has(corridor.from) && !reached.has(corridor.to)) { reached.add(corridor.to); changed = true; }
      if (reached.has(corridor.to) && !reached.has(corridor.from)) { reached.add(corridor.from); changed = true; }
    }
  }
  return reached.size === rooms.length;
}

function roomsOverlap(a, b) {
  const padding = 0.08;
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 - padding &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 - padding;
}

function cleanVersion(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 80);
}

function cleanSeed(value) {
  return String(value || '').replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 160) || 'missing';
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function number(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

function integer(value, minimum, maximum, fallback) {
  return Math.floor(number(value, minimum, maximum, fallback));
}

function round(value, places) {
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
}
