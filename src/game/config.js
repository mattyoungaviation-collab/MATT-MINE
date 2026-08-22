export const CONFIG = Object.freeze({
  width: 1280,
  height: 720,
  worldWidth: 2400,
  worldHeight: 1600,
  gridSize: 80,
  playerRadius: 22,
  basePlayerSpeed: 250,
  playerAcceleration: 13,
  playerFriction: 10,
  basePlayerHealth: 100,
  baseDamage: 20,
  pickaxeDamageScale: 1.14,
  baseAttackCooldown: 0.34,
  baseAttackRange: 120,
  baseCritChance: 0.06,
  baseMagnetRange: 90,
  baseDashCooldown: 2.25,
  baseDashSpeed: 760,
  dashDuration: 0.16,
  safeStartSeconds: 4,
  arenaSafeStartSeconds: 0,
  safeStartEnemyDistance: 320,
  crystalGoalBase: 3,
  bossKillGoal: 1,
  maxDepth: 5,
  deathKeepFraction: 0.35,
  enemySpawnInterval: 1.6,
  maxEnemiesBase: 11,
  blasterEnergyMax: 115,
  blasterEnergyRegen: 17,
  blasterEnergyCost: 12,
  blasterDamageScale: 0.60,
  blasterVolleySpread: 0.2,
  blasterRange: 480,
  dynamiteRange: 285,
  dynamiteDamage: 75,
  guardianProjectileRange: 560,
  guardianAwarenessRange: 760,
  guardianPredictionSeconds: 0.34,
  dynamiteStartAmmo: 0,
  roomWidth: 410,
  roomHeight: 300,
  corridorWidth: 132,
  roomsPerDepth: 7,
  colors: {
    background: '#05070b',
    floor: '#151821',
    floorAlt: '#11151d',
    grid: 'rgba(255,255,255,0.025)',
    wall: '#292d38',
    wallEdge: '#3b4150',
    player: '#f5d142',
    playerEdge: '#fff2a0',
    enemy: '#e94f64',
    enemyEdge: '#ff9cab',
    boss: '#b843f0',
    bossEdge: '#e7a2ff',
    text: '#ffffff',
    copper: '#d27b42',
    gold: '#f4c542',
    crystal: '#50e3c2',
    stone: '#858b98',
    pickup: '#ffdf68',
    portal: '#5c8dff',
    treasure: '#9c65ff'
  }
});


export const WEAPONS = Object.freeze({
  pickaxe: {
    id: 'pickaxe',
    name: 'MATT Pickaxe',
    icon: '⛏',
    description: 'Heavy close-range mining and combat tool.'
  },
  dynamite: {
    id: 'dynamite',
    name: 'Pocket Dynamite',
    icon: '🧨',
    description: 'Limited ammo. Massive area damage.'
  },
  blaster: {
    id: 'blaster',
    name: 'Crystal Blaster',
    icon: '✦',
    description: 'Fast ranged weapon powered by regenerating crystal energy.'
  }
});

export const ORE_TYPES = Object.freeze({
  stone: { name: 'Stone', color: CONFIG.colors.stone, hp: 28, scoreValue: 3, xp: 4, weight: 45 },
  copper: { name: 'Copper', color: CONFIG.colors.copper, hp: 44, scoreValue: 8, xp: 7, weight: 30 },
  gold: { name: 'Gold', color: CONFIG.colors.gold, hp: 64, scoreValue: 20, xp: 12, weight: 18 },
  crystal: { name: 'MATT Crystal', color: CONFIG.colors.crystal, hp: 86, scoreValue: 50, xp: 24, weight: 7 },
  cache: { name: 'Treasure Cache', color: CONFIG.colors.treasure, hp: 145, scoreValue: 95, xp: 38, weight: 0 }
});

export const BLASTER_RUN_UPGRADES = Object.freeze([
  { id: 'blastercap', name: 'Crystal Battery', description: '+30 maximum Blaster energy and refill it', icon: '▰', max: 4 },
  { id: 'blasterregen', name: 'Flux Charger', description: '+35% Blaster recharge speed', icon: '↻', max: 4 },
  { id: 'blasterpower', name: 'Focused Core', description: '+10% Blaster damage', icon: '✦', max: 4 },
  { id: 'blastervolley', name: 'Split Prism', description: 'Add one beam and split damage across the volley', icon: '⋔', max: 2 }
]);
export const RUN_UPGRADES = Object.freeze([
  { id: 'power', name: 'Heavy Pick', description: '+25% attack and mining damage', icon: '⛏', max: 6 },
  { id: 'speed', name: 'Fast Boots', description: '+12% movement speed', icon: '⚡', max: 5 },
  { id: 'health', name: 'Reinforced Vest', description: '+25 max health and heal 25', icon: '❤', max: 6 },
  { id: 'haste', name: 'Quick Hands', description: 'Attack 15% faster', icon: '✦', max: 6 },
  { id: 'range', name: 'Long Handle', description: '+20% attack range', icon: '↔', max: 4 },
  { id: 'crit', name: 'Lucky Strike', description: '+8% critical chance', icon: '★', max: 5 },
  { id: 'magnet', name: 'Ore Magnet', description: '+45 pickup range', icon: '◉', max: 5 },
  { id: 'armor', name: 'Rock Armor', description: 'Take 8% less damage', icon: '⬢', max: 5 },
  { id: 'dash', name: 'Blast Boots', description: 'Dash recharges 25% faster', icon: '➤', max: 5 },
  { id: 'dynamite', name: 'Pocket Dynamite', description: 'Every fifth hit explodes nearby targets', icon: '🧨', max: 3 },
  { id: 'drone', name: 'Mining Drone', description: 'A drone automatically attacks nearby threats', icon: '◆', max: 4 }
]);
