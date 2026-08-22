export const PASS_CHEST_ID = 'season_one_pass_chest';

export const COSMETIC_SLOTS = Object.freeze([
  'badge',
  'trail',
  'weapon',
  'skin',
  'frame',
  'aura',
  'title',
  'trophy'
]);

export const PASS_COSMETICS = Object.freeze({
  starter_badge: Object.freeze({
    id: 'starter_badge',
    slot: 'badge',
    name: 'Starter Badge',
    description: 'The official MATT coin logo, earned permanently in Season One.',
    icon: 'M',
    image: '/assets/matt-coin-official.png'
  }),
  gold_trail: Object.freeze({
    id: 'gold_trail',
    slot: 'trail',
    name: 'Gold Trail',
    description: 'Leaves a bright gold trail while your miner moves.',
    icon: '✦'
  }),
  molten_pickaxe: Object.freeze({
    id: 'molten_pickaxe',
    slot: 'weapon',
    name: 'Molten Pickaxe',
    description: 'An ember-lit pickaxe found inside the Pass Chest.',
    icon: '⛏'
  }),
  crystal_skin: Object.freeze({
    id: 'crystal_skin',
    slot: 'skin',
    name: 'Crystal Skin',
    description: 'Transforms MATT into a glowing crystal miner.',
    icon: '◆'
  }),
  founder_frame: Object.freeze({
    id: 'founder_frame',
    slot: 'frame',
    name: 'Founder Frame',
    description: 'Adds a premium gold frame to leaderboard appearances.',
    icon: '▣'
  }),
  guardian_aura: Object.freeze({
    id: 'guardian_aura',
    slot: 'aura',
    name: 'Guardian Aura',
    description: 'Surrounds your miner with Guardian energy.',
    icon: '◉'
  }),
  ore_reactor_title: Object.freeze({
    id: 'ore_reactor_title',
    slot: 'title',
    name: 'Ore Reactor',
    description: 'Displays the Ore Reactor title beside your wallet.',
    icon: '⚡'
  }),
  season_trophy: Object.freeze({
    id: 'season_trophy',
    slot: 'trophy',
    name: 'Season One Trophy',
    description: 'The permanent trophy for completing the first Pass.',
    icon: '★'
  })
});

export const PASS_REWARD_LEVELS = Object.freeze([
  Object.freeze({ level: 1, type: 'cosmetic', cosmeticId: 'starter_badge', name: 'Starter Badge' }),
  Object.freeze({ level: 2, type: 'cosmetic', cosmeticId: 'gold_trail', name: 'Gold Trail' }),
  Object.freeze({ level: 3, type: 'chest', chestId: PASS_CHEST_ID, name: 'Pass Chest' }),
  Object.freeze({ level: 4, type: 'cosmetic', cosmeticId: 'crystal_skin', name: 'Crystal Skin' }),
  Object.freeze({ level: 5, type: 'cosmetic', cosmeticId: 'founder_frame', name: 'Founder Frame' }),
  Object.freeze({ level: 6, type: 'cosmetic', cosmeticId: 'guardian_aura', name: 'Guardian Aura' }),
  Object.freeze({ level: 7, type: 'cosmetic', cosmeticId: 'ore_reactor_title', name: 'Ore Reactor Title' }),
  Object.freeze({ level: 8, type: 'cosmetic', cosmeticId: 'season_trophy', name: 'Season Trophy' })
]);

export function defaultPassInventory() {
  return {
    claimedLevels: [],
    cosmetics: [],
    equipped: Object.fromEntries(COSMETIC_SLOTS.map((slot) => [slot, ''])),
    chests: {
      [PASS_CHEST_ID]: {
        available: 0,
        opened: 0,
        lastOpenedAt: 0
      }
    }
  };
}

export function rewardForLevel(level) {
  return PASS_REWARD_LEVELS.find((reward) => reward.level === Number(level)) || null;
}

export function cosmeticById(id) {
  return PASS_COSMETICS[String(id || '')] || null;
}

export function canEquipCosmetic(inventory, slot, cosmeticId) {
  const cosmetic = cosmeticById(cosmeticId);
  return Boolean(
    COSMETIC_SLOTS.includes(slot) &&
    cosmetic &&
    cosmetic.slot === slot &&
    inventory?.cosmetics?.includes(cosmetic.id)
  );
}

export function cosmeticLabel(loadout = {}) {
  return ['title', 'badge', 'trophy']
    .map((slot) => cosmeticById(loadout[slot]))
    .filter(Boolean)
    .map((cosmetic) => cosmetic.name)
    .join(' · ');
}
