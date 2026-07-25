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
  baseAttackCooldown: 0.34,
  baseAttackRange: 100,
  baseCritChance: 0.06,
  baseMagnetRange: 90,
  baseDashCooldown: 2.25,
  baseDashSpeed: 760,
  dashDuration: 0.16,
  crystalGoalBase: 3,
  bossKillGoal: 1,
  maxDepth: 5,
  deathKeepFraction: 0.35,
  enemySpawnInterval: 1.6,
  maxEnemiesBase: 11,
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

export const ORE_TYPES = Object.freeze({
  stone: { name: 'Stone', color: CONFIG.colors.stone, hp: 28, nuggets: 3, xp: 4, weight: 45 },
  copper: { name: 'Copper', color: CONFIG.colors.copper, hp: 44, nuggets: 8, xp: 7, weight: 30 },
  gold: { name: 'Gold', color: CONFIG.colors.gold, hp: 64, nuggets: 20, xp: 12, weight: 18 },
  crystal: { name: 'MATT Crystal', color: CONFIG.colors.crystal, hp: 86, nuggets: 50, xp: 24, weight: 7 },
  cache: { name: 'Treasure Cache', color: CONFIG.colors.treasure, hp: 145, nuggets: 95, xp: 38, weight: 0 }
});

export const RUN_UPGRADES = Object.freeze([
  { id: 'power', name: 'Heavy Pick', description: '+25% attack and mining damage', icon: '⛏' },
  { id: 'speed', name: 'Fast Boots', description: '+12% movement speed', icon: '⚡' },
  { id: 'health', name: 'Reinforced Vest', description: '+25 max health and heal 25', icon: '❤' },
  { id: 'haste', name: 'Quick Hands', description: 'Attack 15% faster', icon: '✦' },
  { id: 'range', name: 'Long Handle', description: '+20% attack range', icon: '↔' },
  { id: 'crit', name: 'Lucky Strike', description: '+8% critical chance', icon: '★' },
  { id: 'magnet', name: 'Ore Magnet', description: '+45 pickup range', icon: '◉' },
  { id: 'armor', name: 'Rock Armor', description: 'Take 12% less damage', icon: '⬢' },
  { id: 'dash', name: 'Blast Boots', description: 'Dash recharges 25% faster', icon: '➤' },
  { id: 'dynamite', name: 'Pocket Dynamite', description: 'Every fifth hit explodes nearby targets', icon: '🧨' },
  { id: 'drone', name: 'Mining Drone', description: 'A drone automatically attacks nearby threats', icon: '◆' },
  { id: 'fortune', name: 'Prospector Luck', description: '+15% value from all collected loot', icon: '♛' }
]);

export const META_UPGRADES = Object.freeze([
  { id: 'health', name: 'Base Health', description: '+8 starting health per rank', baseCost: 75, max: 10 },
  { id: 'damage', name: 'Pick Power', description: '+5% starting damage per rank', baseCost: 90, max: 10 },
  { id: 'speed', name: 'Boot Speed', description: '+2% starting movement speed per rank', baseCost: 70, max: 10 },
  { id: 'luck', name: 'Crystal Luck', description: '+1% rich ore chance per rank', baseCost: 125, max: 8 }
]);
