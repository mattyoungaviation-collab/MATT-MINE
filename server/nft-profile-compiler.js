const EVOLUTION_NAMES = Object.freeze([
  'rookie-miner',
  'apprentice-miner',
  'crystal-hunter',
  'veteran-miner',
  'vault-raider',
  'elite-miner',
  'mine-legend'
]);

const ITEM_TYPES = Object.freeze(['weapon', 'backpack', 'helmet', 'armor']);
const V2_SLOTS = Object.freeze(['armor', 'pickaxe', 'blaster', 'dynamite', 'helmet', 'backpack']);

/**
 * Compiles authoritative on-chain Miner and Equipment state into the one fixed
 * character layout consumed by NFT metadata generation and game rendering.
 * This function has no browser or wallet authority and performs no chain write.
 */
export function compileMinerNftProfile(input = {}) {
  if (input.version === 2 || input.contractVersion === 2 || input.traits || input.effectiveTraits) {
    return compileV2MinerNftProfile(input);
  }
  return compileV1MinerNftProfile(input);
}

function compileV2MinerNftProfile(input) {
  const minerId = positiveInteger(input.minerId, 'minerId');
  const owner = normalizedAddress(input.owner, 'owner');
  const traits = normalizeV2Traits(input.traits);
  const effectiveTraits = normalizeV2EffectiveTraits(input.effectiveTraits, traits);
  const tokenIds = normalizeV2Loadout(input.loadout);
  const equipment = normalizeV2Equipment(input.equipment, tokenIds, minerId);
  const progression = Object.freeze({
    bankedXp: traits.bankedXp,
    level: traits.level,
    evolution: traits.evolution,
    crystalsPerHour: traits.crystalsPerHour,
    lastVerifiedPlay: traits.lastVerifiedPlay,
    activeUntil: traits.activeUntil,
    cphAssignedAt: traits.cphAssignedAt,
    earningStatus: ['Not Eligible', 'Earning', 'Inactive'][traits.earningStatus]
  });
  const equipped = Object.freeze({
    armor: tokenIds.armor,
    pickaxe: tokenIds.pickaxe,
    blaster: tokenIds.blaster,
    dynamite: tokenIds.dynamite,
    helmet: tokenIds.helmet,
    backpack: tokenIds.backpack
  });
  return Object.freeze({
    version: 2,
    contractVersion: 2,
    minerId,
    owner,
    progression,
    traits,
    effectiveTraits,
    equipped,
    equipment: Object.freeze(equipment),
    gameplay: Object.freeze({
      ...effectiveTraits,
      effectiveTraits,
      armorEffective: Boolean(equipped.armor && !equipment.armor?.damaged),
      runLocked: traits.runLocked
    }),
    render: Object.freeze({
      layout: 'matt-miner-fixed-v2',
      baseEvolution: EVOLUTION_NAMES[traits.evolution],
      layers: Object.freeze([
        renderLayer('armor', equipment.armor),
        renderLayer('backpack', equipment.backpack),
        renderLayer('helmet', equipment.helmet),
        // The current art pack has a held Pickaxe layer. Blaster and Dynamite
        // remain visible as metadata traits until their approved render layers
        // are added; their on-chain bonuses are already active in gameplay.
        renderLayer('weapon', equipment.pickaxe)
      ].filter(Boolean)),
      damagedArmorFlashRed: Boolean(equipment.armor?.damaged)
    })
  });
}

function compileV1MinerNftProfile(input) {
  const minerId = positiveInteger(input.minerId, 'minerId');
  const owner = normalizedAddress(input.owner, 'owner');
  const progression = normalizeProgression(input.progression);
  const loadout = normalizeLoadout(input.loadout);
  const equipment = normalizeEquipment(input.equipment, loadout, minerId);
  const armor = equipment.armor;
  const activeBackpack = equipment.backpack;

  return Object.freeze({
    minerId,
    owner,
    progression,
    equipped: Object.freeze({
      weapon: equipment.weapon?.tokenId || 0,
      backpack: activeBackpack?.tokenId || 0,
      helmet: equipment.helmet?.tokenId || 0,
      armor: armor?.tokenId || 0,
      queuedBackpacks: loadout.backpackCount
    }),
    gameplay: Object.freeze({
      maximumHealth: armor && !armor.damaged ? armor.armorHp : 100,
      crystalCarryMultiplier: activeBackpack ? 2 : 1,
      armorEffective: Boolean(armor && !armor.damaged),
      runLocked: loadout.runLocked
    }),
    render: Object.freeze({
      layout: 'matt-miner-fixed-v1',
      baseEvolution: EVOLUTION_NAMES[progression.evolution],
      layers: Object.freeze([
        renderLayer('armor', armor),
        renderLayer('backpack', activeBackpack),
        renderLayer('helmet', equipment.helmet),
        renderLayer('weapon', equipment.weapon)
      ].filter(Boolean)),
      damagedArmorFlashRed: Boolean(armor?.damaged)
    })
  });
}

function normalizeV2Traits(value = {}) {
  const level = boundedInteger(value.level, 'traits.level', 1, 100);
  const evolution = boundedInteger(value.evolution ?? evolutionForLevel(level), 'traits.evolution', 0, 6);
  if (evolution !== evolutionForLevel(level)) throw new Error('traits evolution does not match level');
  return Object.freeze({
    bankedXp: nonNegativeInteger(value.bankedXp || 0, 'traits.bankedXp'),
    baseHealth: boundedInteger(value.baseHealth, 'traits.baseHealth', 50, 150),
    pickaxeAttack: boundedInteger(value.pickaxeAttack, 'traits.pickaxeAttack', 15, 35),
    blasterAttack: boundedInteger(value.blasterAttack, 'traits.blasterAttack', 5, 30),
    dynamiteAttack: boundedInteger(value.dynamiteAttack, 'traits.dynamiteAttack', 20, 80),
    healAmount: boundedInteger(value.healAmount, 'traits.healAmount', 10, 50),
    baseCarryCapacity: boundedInteger(value.baseCarryCapacity, 'traits.baseCarryCapacity', 750, 1_500),
    deathRetentionBps: boundedInteger(value.deathRetentionBps, 'traits.deathRetentionBps', 1_000, 5_000),
    level,
    evolution,
    crystalsPerHour: boundedInteger(value.crystalsPerHour || 0, 'traits.crystalsPerHour', 0, 50),
    lastVerifiedPlay: nonNegativeInteger(value.lastVerifiedPlay || 0, 'traits.lastVerifiedPlay'),
    activeUntil: nonNegativeInteger(value.activeUntil || 0, 'traits.activeUntil'),
    cphAssignedAt: nonNegativeInteger(value.cphAssignedAt || 0, 'traits.cphAssignedAt'),
    earningStatus: boundedInteger(value.earningStatus || 0, 'traits.earningStatus', 0, 2),
    runLocked: value.runLocked === true
  });
}

function normalizeV2EffectiveTraits(value = {}, base) {
  return Object.freeze({
    maximumHealth: boundedInteger(value.maximumHealth ?? base.baseHealth, 'effectiveTraits.maximumHealth', 1, 65_535),
    armorShield: boundedInteger(value.armorShield || 0, 'effectiveTraits.armorShield', 0, 65_535),
    pickaxeAttack: boundedInteger(value.pickaxeAttack ?? base.pickaxeAttack, 'effectiveTraits.pickaxeAttack', 1, 65_535),
    blasterAttack: boundedInteger(value.blasterAttack ?? base.blasterAttack, 'effectiveTraits.blasterAttack', 1, 65_535),
    dynamiteAttack: boundedInteger(value.dynamiteAttack ?? base.dynamiteAttack, 'effectiveTraits.dynamiteAttack', 1, 65_535),
    healAmount: boundedInteger(value.healAmount ?? base.healAmount, 'effectiveTraits.healAmount', 1, 65_535),
    carryCapacity: boundedInteger(value.carryCapacity ?? base.baseCarryCapacity, 'effectiveTraits.carryCapacity', 1, 65_535),
    deathRetentionBps: boundedInteger(value.deathRetentionBps ?? base.deathRetentionBps, 'effectiveTraits.deathRetentionBps', 0, 10_000),
    level: base.level,
    crystalsPerHour: base.crystalsPerHour
  });
}

function normalizeV2Loadout(value = {}) {
  const source = Array.isArray(value) ? value : V2_SLOTS.map((slot) => value[slot] || 0);
  return Object.freeze(Object.fromEntries(V2_SLOTS.map((slot, index) => [
    slot,
    nonNegativeInteger(source[index] ?? source[slot] ?? 0, `loadout.${slot}`)
  ])));
}

function normalizeV2Equipment(raw = {}, loadout, minerId) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(V2_SLOTS.map((slot, slotIndex) => {
    const tokenId = loadout[slot];
    if (!tokenId) return [slot, null];
    const item = source[tokenId] || source[String(tokenId)];
    if (!item) throw new Error(`missing equipment data for ${slot} token ${tokenId}`);
    const itemSlot = boundedInteger(item.slot, `${slot}.slot`, 0, 5);
    if (itemSlot !== slotIndex) throw new Error(`${slot} token has the wrong slot`);
    const equippedToMiner = positiveInteger(item.equippedToMiner, `${slot}.equippedToMiner`);
    if (equippedToMiner !== minerId) throw new Error(`${slot} token is assigned to another Miner`);
    return [slot, Object.freeze({
      tokenId,
      definitionId: positiveInteger(item.definitionId, `${slot}.definitionId`),
      slot: itemSlot,
      rarity: boundedInteger(item.rarity, `${slot}.rarity`, 0, 4),
      bonus: boundedInteger(item.bonus || 0, `${slot}.bonus`, 0, 65_535),
      damaged: slot === 'armor' && item.damaged === true,
      equippedToMiner
    })];
  }));
}

function normalizeProgression(value = {}) {
  const level = boundedInteger(value.level, 'progression.level', 1, 100);
  const evolution = evolutionForLevel(level);
  const suppliedEvolution = value.evolution === undefined
    ? evolution
    : boundedInteger(value.evolution, 'progression.evolution', 0, 6);
  if (suppliedEvolution !== evolution) throw new Error('progression evolution does not match level');
  return Object.freeze({
    bankedXp: nonNegativeInteger(value.bankedXp || 0, 'progression.bankedXp'),
    prestigeXp: nonNegativeInteger(value.prestigeXp || 0, 'progression.prestigeXp'),
    level,
    evolution
  });
}

function normalizeLoadout(value = {}) {
  return Object.freeze({
    weapon: nonNegativeInteger(value.weapon || 0, 'loadout.weapon'),
    backpackHead: nonNegativeInteger(value.backpackHead || 0, 'loadout.backpackHead'),
    backpackTail: nonNegativeInteger(value.backpackTail || 0, 'loadout.backpackTail'),
    helmet: nonNegativeInteger(value.helmet || 0, 'loadout.helmet'),
    armor: nonNegativeInteger(value.armor || 0, 'loadout.armor'),
    backpackCount: nonNegativeInteger(value.backpackCount || 0, 'loadout.backpackCount'),
    runLocked: value.runLocked === true
  });
}

function normalizeEquipment(raw = {}, loadout, minerId) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const tokenIds = {
    weapon: loadout.weapon,
    backpack: loadout.backpackHead,
    helmet: loadout.helmet,
    armor: loadout.armor
  };
  return Object.fromEntries(Object.entries(tokenIds).map(([slot, tokenId]) => {
    if (!tokenId) return [slot, null];
    const item = source[tokenId] || source[String(tokenId)];
    if (!item) throw new Error(`missing equipment data for ${slot} token ${tokenId}`);
    const itemType = boundedInteger(item.itemType, `${slot}.itemType`, 0, 3);
    if (ITEM_TYPES[itemType] !== slot) throw new Error(`${slot} token has the wrong item type`);
    const equippedToMiner = positiveInteger(item.equippedToMiner, `${slot}.equippedToMiner`);
    if (equippedToMiner !== minerId) throw new Error(`${slot} token is assigned to another Miner`);
    const armorHp = nonNegativeInteger(item.armorHp || 0, `${slot}.armorHp`);
    if ((slot === 'armor') !== (armorHp > 0)) throw new Error(`${slot} has an invalid armor HP value`);
    return [slot, Object.freeze({
      tokenId,
      definitionId: positiveInteger(item.definitionId, `${slot}.definitionId`),
      rarity: boundedInteger(item.rarity, `${slot}.rarity`, 0, 4),
      armorHp,
      damaged: item.damaged === true
    })];
  }));
}

function renderLayer(slot, item) {
  if (!item) return null;
  return Object.freeze({
    slot,
    tokenId: item.tokenId,
    definitionId: item.definitionId,
    rarity: item.rarity,
    state: slot === 'armor' && item.damaged ? 'damaged' : 'active'
  });
}

function evolutionForLevel(level) {
  if (level >= 100) return 6;
  if (level >= 75) return 5;
  if (level >= 50) return 4;
  if (level >= 35) return 3;
  if (level >= 25) return 2;
  if (level >= 10) return 1;
  return 0;
}

function normalizedAddress(value, label) {
  const address = String(value || '').trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(address) || /^0x0{40}$/.test(address)) throw new Error(`${label} is invalid`);
  return address;
}

function positiveInteger(value, label) {
  const number = nonNegativeInteger(value, label);
  if (number === 0) throw new Error(`${label} must be greater than zero`);
  return number;
}

function nonNegativeInteger(value, label) {
  const number = typeof value === 'bigint' ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`${label} must be a safe non-negative integer`);
  return number;
}

function boundedInteger(value, label, minimum, maximum) {
  const number = nonNegativeInteger(value, label);
  if (number < minimum || number > maximum) throw new Error(`${label} is outside ${minimum}-${maximum}`);
  return number;
}
