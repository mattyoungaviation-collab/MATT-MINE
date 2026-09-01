export const CHARACTER_IDS = Object.freeze(['matt', 'ronke', 'adl-dyno', 'axie', 'orc']);

export const CHARACTER_DEFAULTS = Object.freeze({
  matt: character('MATT', 'Balanced miner for every mode.', {
    baseHealth: 100, movementSpeed: 1, dashCooldown: 1, dashStrength: 1,
    pickaxeDamage: 1, miningSpeed: 1, blasterDamage: 1, blasterEnergy: 100,
    armor: 0, magnetRange: 1, luck: 1, passive: 'Balanced'
  }),
  ronke: character('Ronke', 'Fast scout with quick dash recovery.', {
    baseHealth: 82, movementSpeed: 1.16, dashCooldown: .76, dashStrength: 1.08,
    pickaxeDamage: .94, miningSpeed: 1.05, blasterDamage: 1, blasterEnergy: 100,
    armor: 0, magnetRange: 1.08, luck: 1.05, passive: 'Fleet Footed'
  }),
  'adl-dyno': character('ADL Dyno', 'Heavy miner with powerful pickaxe strikes.', {
    baseHealth: 135, movementSpeed: .86, dashCooldown: 1.18, dashStrength: .96,
    pickaxeDamage: 1.24, miningSpeed: 1.22, blasterDamage: .82, blasterEnergy: 90,
    armor: .08, magnetRange: .95, luck: 1, passive: 'Heavy Miner'
  }, { passRequirement: 8 }),
  axie: character('Axie', 'Crystal specialist with a powerful Blaster.', {
    baseHealth: 78, movementSpeed: .92, dashCooldown: 1.05, dashStrength: 1,
    pickaxeDamage: .88, miningSpeed: .9, blasterDamage: 1.28, blasterEnergy: 125,
    armor: 0, magnetRange: 1.12, luck: 1.08, passive: 'Crystal Charge'
  }),
  orc: character('Orc', 'Durable survivor with lower damage.', {
    baseHealth: 165, movementSpeed: .82, dashCooldown: 1.25, dashStrength: .9,
    pickaxeDamage: .78, miningSpeed: .9, blasterDamage: .72, blasterEnergy: 85,
    armor: .14, magnetRange: .9, luck: .92, passive: 'Iron Hide'
  })
});

export const EXPANSION_SCHEMA = Object.freeze([
  field('chestOpeningEnabled', 'Chest Rewards', 'Chest opening enabled', 'boolean', true, 0, 1, 'Immediately gates server chest openings.'),
  field('chestMaxOpenings', 'Chest Rewards', 'Lifetime opening limit', 'integer', 1, 1, 100, 'Maximum openings of this chest per wallet.'),
  field('chestCosmeticDropsEnabled', 'Chest Rewards', 'Cosmetic drops enabled', 'boolean', true, 0, 1, 'Controls whether Pass chests include a permanent cosmetic.'),
  field('chestCosmeticId', 'Chest Rewards', 'Primary cosmetic', 'enum', 'molten_pickaxe', 0, 0, 'Primary chest cosmetic before duplicate handling.', [
    'starter_badge', 'gold_trail', 'molten_pickaxe', 'crystal_skin',
    'founder_frame', 'guardian_aura', 'ore_reactor_title', 'season_trophy'
  ]),
  field('deathRetentionPractice', 'Death and Revives', 'Practice score retention percent', 'number', 50, 0, 100, 'Applied with floor rounding to the rewardless Practice score summary.'),
  field('deathRetentionFree', 'Death and Revives', 'Free retention percent', 'number', 50, 0, 100, 'Applied with floor rounding.'),
  field('deathRetentionPaid', 'Death and Revives', 'Pass score retention percent', 'number', 50, 0, 100, 'Applied with floor rounding to legacy run score. The Miner NFT trait exclusively controls MATT Crystal death retention.'),
  field('paidRevivesEnabled', 'Death and Revives', 'Paid revives enabled', 'boolean', false, 0, 1, 'Release blocker remains off until exact verified payment handling is configured.'),
  field('revivePriceRonWei', 'Death and Revives', 'Revive price (RON wei)', 'atomic', '10000000000000000000', 0, 0, 'Exact verified price; default 10 RON.'),
  field('reviveLimitPerRun', 'Death and Revives', 'Revive limit per run', 'integer', 1, 0, 3, 'Maximum verified revives before finalization.'),
  field('reviveInvulnerabilitySeconds', 'Death and Revives', 'Revive invulnerability', 'number', 3, 0, 15, 'Safe-start protection after a verified revive.'),
  field('betaModeEnabled', 'Beta Testing', 'Beta mode enabled', 'boolean', false, 0, 1, 'Only approved beta testers and Admin may enter.'),
  field('controllerDeadZone', 'Controller Defaults', 'Stick dead zone', 'number', .18, 0, .5, 'Default for newly created player profiles. Input below this radius is ignored; players may override it.'),
  field('controllerAimSensitivity', 'Controller Defaults', 'Aim sensitivity', 'number', 1, .25, 3, 'Default right-stick aiming multiplier for newly created player profiles; players may override it.'),
  field('controllerVibration', 'Controller Defaults', 'Vibration enabled', 'boolean', true, 0, 1, 'Default for newly created player profiles; players may override it.'),
  field('weeklyCompetitionEnabled', 'Weekly Competition', 'Weekly competition enabled', 'boolean', false, 0, 1, 'Keeps the new mode unavailable until released.'),
  field('weeklyActiveDayCount', 'Weekly Competition', 'Active weekly day count', 'integer', 1, 1, 7, 'Launch with one day and expand safely to seven.'),
  field('weeklyLockedCharacter', 'Weekly Competition', 'Locked character', 'enum', 'matt', 0, 0, 'Same character rule for all entrants.', CHARACTER_IDS),
  field('weeklyAttemptLimit', 'Weekly Competition', 'Attempts per UTC day', 'integer', 1, 1, 1, 'Fairness invariant: exactly one.'),
  ...Array.from({ length: 7 }, (_, index) => {
    const day = index + 1;
    return [
      field(`weeklyDay${day}Difficulty`, 'Weekly Competition', `Day ${day} difficulty`, 'number', 1 + index * .18, .5, 5, 'Immutable after that UTC stage opens.'),
      field(`weeklyDay${day}BossCount`, 'Weekly Competition', `Day ${day} boss count`, 'integer', day >= 6 ? 2 : 1, 0, 10, 'Immutable after that UTC stage opens.'),
      field(`weeklyDay${day}RoomCount`, 'Weekly Competition', `Day ${day} room count`, 'integer', 7 + index, 3, 30, 'Immutable after that UTC stage opens.')
    ];
  }).flat(),
  field('endlessEnabled', 'Endless Mode', 'Endless enabled', 'boolean', false, 0, 1, 'Keeps the new leaderboard unavailable until released.'),
  field('endlessHealthGrowth', 'Endless Mode', 'Enemy health growth per depth', 'number', .16, 0, 1, 'Compounded and capped by maximum scale.'),
  field('endlessDamageGrowth', 'Endless Mode', 'Enemy damage growth per depth', 'number', .1, 0, 1, 'Compounded and capped by maximum scale.'),
  field('endlessSpeedGrowth', 'Endless Mode', 'Enemy speed growth per depth', 'number', .035, 0, .25, 'Compounded and capped by maximum scale.'),
  field('endlessBossFrequency', 'Endless Mode', 'Boss every N depths', 'integer', 2, 1, 20, 'Depth interval for Guardian encounters.'),
  field('endlessBossCount', 'Endless Mode', 'Base boss count', 'integer', 1, 1, 10, 'Can scale further within safeguards.'),
  field('endlessRoomCount', 'Endless Mode', 'Base room count', 'integer', 8, 3, 30, 'Generated rooms per depth.'),
  field('endlessMultiplierGrowth', 'Endless Mode', 'Score multiplier growth', 'number', .25, 0, 2, 'Added per completed depth.'),
  field('endlessMaximumScale', 'Endless Mode', 'Maximum difficulty scale', 'number', 8, 1, 50, 'Hard safeguard for health, damage, and speed scaling.'),
  field('endlessSeasonDays', 'Endless Mode', 'Season length in days', 'integer', 30, 1, 180, 'Server leaderboard reset window.')
]);

export function defaultExpansionConfig() {
  return {
    settings: Object.fromEntries(EXPANSION_SCHEMA.map((entry) => [entry.id, entry.default])),
    characters: structuredClone(CHARACTER_DEFAULTS),
    revision: 1,
    updatedAt: 0,
    updatedBy: ''
  };
}

export function normalizeExpansionConfig(input = {}) {
  const defaults = defaultExpansionConfig();
  const source = record(input);
  const settingsSource = record(source.settings);
  const settings = Object.fromEntries(EXPANSION_SCHEMA.map((definition) => [
    definition.id,
    normalizeField(definition, settingsSource[definition.id] ?? definition.default)
  ]));
  const characterSource = record(source.characters);
  const characters = Object.fromEntries(CHARACTER_IDS.map((id) => [
    id,
    normalizeCharacter(id, characterSource[id] || defaults.characters[id])
  ]));
  return {
    settings,
    characters,
    revision: integer(source.revision, 1, Number.MAX_SAFE_INTEGER, 1),
    updatedAt: integer(source.updatedAt, 0, Number.MAX_SAFE_INTEGER, 0),
    updatedBy: typeof source.updatedBy === 'string' ? source.updatedBy.slice(0, 80) : ''
  };
}

export function normalizeExpansionPatch(input = {}, current = defaultExpansionConfig()) {
  const patch = record(input);
  const allowed = new Set(['settings', 'characters']);
  for (const key of Object.keys(patch)) if (!allowed.has(key)) throw new Error(`Unknown expansion section: ${key}`);
  const merged = structuredClone(current);
  if (patch.settings !== undefined) {
    const settings = record(patch.settings);
    const byId = new Map(EXPANSION_SCHEMA.map((entry) => [entry.id, entry]));
    for (const [key, value] of Object.entries(settings)) {
      const definition = byId.get(key);
      if (!definition) throw new Error(`Unknown expansion setting: ${key}`);
      merged.settings[key] = normalizeField(definition, value);
    }
  }
  if (patch.characters !== undefined) {
    const characters = record(patch.characters);
    for (const [id, value] of Object.entries(characters)) {
      if (!CHARACTER_IDS.includes(id)) throw new Error(`Unknown character: ${id}`);
      const characterPatch = record(value);
      const allowedFields = new Set(Object.keys(CHARACTER_DEFAULTS[id]));
      for (const fieldId of Object.keys(characterPatch)) {
        if (!allowedFields.has(fieldId)) throw new Error(`Unknown ${id} character field: ${fieldId}`);
      }
      merged.characters[id] = normalizeCharacter(id, { ...merged.characters[id], ...characterPatch });
    }
  }
  return normalizeExpansionConfig(merged);
}

export function defaultPlayerExpansion() {
  return {
    betaTester: false,
    ownedCharacters: [...CHARACTER_IDS],
    selectedCharacter: 'matt',
    controller: defaultControllerProfile(),
    characterHistory: [],
    adCompletions: {},
    revivePayments: {}
  };
}

export function normalizePlayerExpansion(input = {}) {
  const source = record(input);
  const owned = [...CHARACTER_IDS];
  return {
    betaTester: source.betaTester === true,
    ownedCharacters: owned,
    selectedCharacter: owned.includes(source.selectedCharacter) ? source.selectedCharacter : 'matt',
    controller: normalizeControllerProfile(source.controller),
    characterHistory: Array.isArray(source.characterHistory) ? source.characterHistory.slice(-500) : [],
    adCompletions: record(source.adCompletions),
    revivePayments: record(source.revivePayments)
  };
}

export const CONTROLLER_ACTIONS = Object.freeze([
  'attack', 'dash', 'pickaxe', 'dynamite', 'blaster', 'medicPack', 'forceField', 'interact', 'pause',
  'confirm', 'cancel', 'menuUp', 'menuDown', 'menuLeft', 'menuRight'
]);

const LEGACY_CONTROLLER_MAPPING = Object.freeze({
  attack: 0, dash: 1, pickaxe: 4, dynamite: 2, blaster: 5, interact: 3,
  medicPack: 6, forceField: 11,
  pause: 9, confirm: 0, cancel: 1, menuUp: 12, menuDown: 13, menuLeft: 14, menuRight: 15
});

const DEFAULT_CONTROLLER_MAPPING = Object.freeze({
  attack: 7, dash: 10, pickaxe: 4, dynamite: 2, blaster: 5, interact: 3,
  medicPack: 6, forceField: 11,
  pause: 9, confirm: 0, cancel: 1, menuUp: 12, menuDown: 13, menuLeft: 14, menuRight: 15
});

export function defaultControllerProfile() {
  return {
    layoutVersion: 2,
    deadZone: .18,
    aimSensitivity: 1,
    vibration: true,
    activeIndex: 0,
    mapping: { ...DEFAULT_CONTROLLER_MAPPING }
  };
}

export function normalizeControllerProfile(input = {}) {
  const source = record(input);
  const defaults = defaultControllerProfile();
  const suppliedMapping = record(source.mapping);
  const shouldMigrateLegacyDefaults = Number(source.layoutVersion || 0) < 2 &&
    CONTROLLER_ACTIONS.every((action) =>
      Number(suppliedMapping[action] ?? LEGACY_CONTROLLER_MAPPING[action]) === LEGACY_CONTROLLER_MAPPING[action]
    );
  const mappingSource = shouldMigrateLegacyDefaults ? defaults.mapping : suppliedMapping;
  const mapping = {};
  const used = new Set();
  for (const action of CONTROLLER_ACTIONS) {
    const button = integer(mappingSource[action], 0, 31, defaults.mapping[action]);
    if (['attack', 'dash', 'pickaxe', 'dynamite', 'blaster', 'medicPack', 'forceField', 'interact', 'pause'].includes(action)) {
      if (used.has(button)) throw new Error(`Controller button ${button} is assigned more than once.`);
      used.add(button);
    }
    mapping[action] = button;
  }
  return {
    layoutVersion: 2,
    deadZone: finite(source.deadZone, 0, .5, defaults.deadZone),
    aimSensitivity: finite(source.aimSensitivity, .25, 3, defaults.aimSensitivity),
    vibration: source.vibration !== false,
    activeIndex: integer(source.activeIndex, 0, 3, 0),
    mapping
  };
}

export function endlessScale(depth, settings) {
  const level = Math.max(0, Math.floor(Number(depth) || 1) - 1);
  const maximum = Number(settings.endlessMaximumScale || 8);
  return {
    health: Math.min(maximum, (1 + Number(settings.endlessHealthGrowth || 0)) ** level),
    damage: Math.min(maximum, (1 + Number(settings.endlessDamageGrowth || 0)) ** level),
    speed: Math.min(maximum, (1 + Number(settings.endlessSpeedGrowth || 0)) ** level),
    multiplier: 1 + level * Number(settings.endlessMultiplierGrowth || 0)
  };
}

export function weeklyStageSeed(week, dayNumber) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(week)) || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 7) {
    throw new Error('A valid UTC week and day number are required.');
  }
  return `MATT-WEEKLY-${week}-DAY-${dayNumber}`;
}

function character(name, description, stats, unlock = {}) {
  return {
    name, description, portrait: '', sprite: '', ...stats,
    unlockRequirement: unlock.unlockRequirement || '',
    passRequirement: unlock.passRequirement || 0,
    progressionRequirement: unlock.progressionRequirement || 0,
    enabled: true
  };
}

function normalizeCharacter(id, input) {
  const source = record(input);
  const defaults = CHARACTER_DEFAULTS[id];
  return {
    name: text(source.name, defaults.name, 40),
    description: text(source.description, defaults.description, 180),
    portrait: text(source.portrait, defaults.portrait, 200),
    sprite: text(source.sprite, defaults.sprite, 200),
    baseHealth: finite(source.baseHealth, 25, 500, defaults.baseHealth),
    movementSpeed: finite(source.movementSpeed, .25, 3, defaults.movementSpeed),
    dashCooldown: finite(source.dashCooldown, .2, 5, defaults.dashCooldown),
    dashStrength: finite(source.dashStrength, .25, 3, defaults.dashStrength),
    pickaxeDamage: finite(source.pickaxeDamage, .1, 5, defaults.pickaxeDamage),
    miningSpeed: finite(source.miningSpeed, .1, 5, defaults.miningSpeed),
    blasterDamage: finite(source.blasterDamage, .1, 5, defaults.blasterDamage),
    blasterEnergy: finite(source.blasterEnergy, 10, 500, defaults.blasterEnergy),
    armor: finite(source.armor, 0, .8, defaults.armor),
    magnetRange: finite(source.magnetRange, .25, 5, defaults.magnetRange),
    luck: finite(source.luck, .25, 5, defaults.luck),
    passive: text(source.passive, defaults.passive, 80),
    unlockRequirement: text(source.unlockRequirement, defaults.unlockRequirement, 120),
    passRequirement: integer(source.passRequirement, 0, 100, defaults.passRequirement),
    progressionRequirement: integer(source.progressionRequirement, 0, 1_000_000, defaults.progressionRequirement),
    enabled: source.enabled !== false
  };
}

function field(id, category, label, type, defaultValue, min, max, description, options = []) {
  return Object.freeze({ id, category, label, type, default: defaultValue, min, max, description, options });
}

function normalizeField(definition, raw) {
  if (definition.type === 'boolean') {
    if (typeof raw !== 'boolean') throw new Error(`${definition.label} must be true or false.`);
    return raw;
  }
  if (definition.type === 'enum') {
    if (!definition.options.includes(raw)) throw new Error(`${definition.label} is invalid.`);
    return raw;
  }
  if (definition.type === 'atomic') {
    const value = String(raw || '');
    if (!/^\d{1,78}$/.test(value)) throw new Error(`${definition.label} must be an unsigned atomic amount.`);
    return value.replace(/^0+(?=\d)/, '');
  }
  return definition.type === 'integer'
    ? integer(raw, definition.min, definition.max, definition.default, true)
    : finite(raw, definition.min, definition.max, definition.default, true);
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function finite(value, min, max, fallback, strict = false) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    if (strict) throw new Error(`Value must be between ${min} and ${max}.`);
    return fallback;
  }
  return number;
}

function integer(value, min, max, fallback, strict = false) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    if (strict) throw new Error(`Value must be an integer between ${min} and ${max}.`);
    return fallback;
  }
  return number;
}

function text(value, fallback, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : fallback;
}
