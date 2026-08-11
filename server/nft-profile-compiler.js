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

/**
 * Compiles authoritative on-chain Miner and Equipment state into the one fixed
 * character layout consumed by NFT metadata generation and game rendering.
 * This function has no browser or wallet authority and performs no chain write.
 */
export function compileMinerNftProfile(input = {}) {
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
