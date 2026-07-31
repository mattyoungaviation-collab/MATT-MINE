import { CHARACTER_IDS } from './expansionConfig.js';

export const COMPETITION_SLOTS = Object.freeze([
  Object.freeze({ id: 'practice', number: 1, name: 'Practice Mine', mode: 'practice', leaderboard: false, color: '#55dfb4' }),
  Object.freeze({ id: 'arena', number: 2, name: 'MATT Arena', mode: 'arena', leaderboard: true, color: '#ffcf32' }),
  Object.freeze({ id: 'daily', number: 3, name: 'Daily Mine', mode: 'free', leaderboard: true, color: '#5bd8ff' }),
  Object.freeze({ id: 'pass', number: 4, name: 'Pass Mine', mode: 'paid', leaderboard: true, color: '#bd74ff' }),
  Object.freeze({ id: 'weekly', number: 5, name: 'Seven-Day Mine', mode: 'weekly', leaderboard: true, color: '#ff805e' }),
  Object.freeze({ id: 'pvp', number: 6, name: 'PvP Mine', mode: 'pvp', leaderboard: false, color: '#6f7787', comingSoon: true })
]);

export const MAP_OBJECT_KINDS = Object.freeze({
  spawn: Object.freeze(['player']),
  objective: Object.freeze(['guardian', 'extraction']),
  enemy: Object.freeze(['slime', 'bat', 'crawler', 'beetle', 'exploder', 'spitter']),
  ore: Object.freeze(['stone', 'copper', 'gold', 'crystal']),
  loot: Object.freeze(['treasure', 'weapon_blaster', 'weapon_dynamite', 'health', 'upgrade']),
  hazard: Object.freeze(['rockfall', 'crystal_field'])
});

const ROOM_TYPES = new Set(['start', 'mining', 'combat', 'mixed', 'treasure', 'guardian']);
const OBJECT_TYPES = new Set(Object.values(MAP_OBJECT_KINDS).flat());
const MAX_ROOMS = 30;
const MAX_OBJECTS = 300;
export const COMPETITION_DEPTH_COUNT = 5;

export function defaultCompetitionStudio(timestamp = Date.now()) {
  const snapshots = {};
  const slots = Object.fromEntries(COMPETITION_SLOTS.map((slot) => {
    const depths = createStarterDepths(slot.id);
    const draft = normalizeCompetitionDraft({
      slotId: slot.id,
      name: slot.name,
      depths,
      loadout: defaultLoadout(),
      rules: defaultSlotRules(slot.id)
    }, slot.id);
    const snapshot = createBootstrapSnapshot(draft);
    snapshots[snapshot.id] = snapshot;
    return [slot.id, {
      draft,
      activeSnapshotId: snapshot.id,
      scheduledSnapshotIds: [snapshot.id],
      updatedAt: timestamp
    }];
  }));
  return { version: 2, slots, snapshots, updatedAt: timestamp };
}

export function normalizeCompetitionStudio(input, timestamp = Date.now()) {
  const defaults = defaultCompetitionStudio(timestamp);
  if (!isRecord(input)) return defaults;
  const snapshots = structuredClone(defaults.snapshots);
  for (const [id, value] of Object.entries(isRecord(input.snapshots) ? input.snapshots : {}).slice(-500)) {
    if (!isRecord(value) || !COMPETITION_SLOTS.some((slot) => slot.id === value.slotId)) continue;
    try {
      const draft = normalizeCompetitionDraft(value, value.slotId);
      snapshots[String(id).slice(0, 100)] = {
        ...draft,
        id: String(value.id || id).slice(0, 100),
        status: ['scheduled', 'live', 'archived'].includes(value.status) ? value.status : 'scheduled',
        effectiveAt: safeTimestamp(value.effectiveAt),
        expiresAt: safeTimestamp(value.expiresAt),
        publishedAt: safeTimestamp(value.publishedAt),
        publishedBy: String(value.publishedBy || 'SERVER_ADMIN').slice(0, 80),
        fingerprint: String(value.fingerprint || '').slice(0, 100)
      };
    } catch {}
  }
  const slots = Object.fromEntries(COMPETITION_SLOTS.map((definition) => {
    const source = isRecord(input.slots?.[definition.id]) ? input.slots[definition.id] : {};
    let draft = defaults.slots[definition.id].draft;
    try {
      draft = normalizeCompetitionDraft(source.draft, definition.id);
    } catch {}
    const bootstrapId = defaults.slots[definition.id].activeSnapshotId;
    const sourceSnapshotIds = Array.isArray(source.scheduledSnapshotIds)
      ? source.scheduledSnapshotIds.filter((id) => snapshots[id]?.slotId === definition.id)
      : [];
    const scheduledSnapshotIds = [
      bootstrapId,
      ...[...new Set(sourceSnapshotIds.filter((id) => id !== bootstrapId))].slice(-89)
    ];
    const requestedActiveId = String(source.activeSnapshotId || '');
    return [definition.id, {
      draft,
      activeSnapshotId: snapshots[requestedActiveId]?.slotId === definition.id
        ? requestedActiveId
        : bootstrapId,
      scheduledSnapshotIds,
      updatedAt: safeTimestamp(source.updatedAt)
    }];
  }));
  return { version: 2, slots, snapshots, updatedAt: safeTimestamp(input.updatedAt) };
}

export function normalizeCompetitionDraft(input, forcedSlotId = '') {
  const source = isRecord(input) ? input : {};
  const slotId = forcedSlotId || String(source.slotId || '');
  const slot = COMPETITION_SLOTS.find((entry) => entry.id === slotId);
  if (!slot) throw new TypeError('Unknown competition slot.');
  const depths = normalizeCompetitionDepths(source, slotId);
  return {
    slotId,
    name: cleanText(source.name || slot.name, 48),
    subtitle: cleanText(source.subtitle || defaultSubtitle(slotId), 120),
    depths,
    map: depths[0].map,
    loadout: normalizeLoadout(source.loadout),
    rules: normalizeRules(source.rules, slotId)
  };
}

export function normalizeCompetitionDepths(input, slotId) {
  const source = isRecord(input) ? input : {};
  const supplied = Array.isArray(source.depths) ? source.depths : [];
  const legacyMap = source.map ? normalizeCompetitionMap(source.map) : null;
  return Array.from({ length: COMPETITION_DEPTH_COUNT }, (_, index) => {
    const depth = index + 1;
    const suppliedDepth = supplied.find((entry) => Number(entry?.depth) === depth) || supplied[index];
    const fallback = legacyMap
      ? {
          ...structuredClone(legacyMap),
          name: depth === 1 ? legacyMap.name : `${legacyMap.name} · Depth ${depth}`
        }
      : createStarterMap(slotId, depth);
    return {
      depth,
      map: normalizeCompetitionMap(suppliedDepth?.map || fallback)
    };
  });
}

export function competitionMapForDepth(snapshot, depth = 1) {
  const normalizedDepth = Math.max(1, Math.min(COMPETITION_DEPTH_COUNT, Math.floor(Number(depth) || 1)));
  const match = Array.isArray(snapshot?.depths)
    ? snapshot.depths.find((entry) => Number(entry?.depth) === normalizedDepth)
    : null;
  return normalizeCompetitionMap(match?.map || snapshot?.map || createStarterMap(snapshot?.slotId || 'practice', normalizedDepth));
}

export function validateCompetitionDraft(input) {
  const draft = normalizeCompetitionDraft(input, input?.slotId);
  const depths = draft.depths.map((entry) => ({
    depth: entry.depth,
    ...validateCompetitionMap(entry.map)
  }));
  const errors = depths.flatMap((entry) => entry.errors.map((message) => `Depth ${entry.depth}: ${message}`));
  const warnings = depths.flatMap((entry) => entry.warnings.map((message) => `Depth ${entry.depth}: ${message}`));
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    depths,
    counts: depths.reduce((totals, entry) => ({
      rooms: totals.rooms + entry.counts.rooms,
      corridors: totals.corridors + entry.counts.corridors,
      objects: totals.objects + entry.counts.objects,
      enemies: totals.enemies + entry.counts.enemies,
      loot: totals.loot + entry.counts.loot
    }), { rooms: 0, corridors: 0, objects: 0, enemies: 0, loot: 0 })
  };
}

export function normalizeCompetitionMap(input) {
  const source = isRecord(input) ? input : {};
  const rooms = Array.isArray(source.rooms)
    ? source.rooms.slice(0, MAX_ROOMS).map((room, index) => normalizeRoom(room, index))
    : [];
  const roomIds = new Set(rooms.map((room) => room.id));
  const corridors = Array.isArray(source.corridors)
    ? source.corridors.slice(0, MAX_ROOMS * 2).map((corridor, index) => ({
        id: cleanId(corridor?.id || `corridor-${index + 1}`),
        from: cleanId(corridor?.from),
        to: cleanId(corridor?.to),
        width: boundedNumber(corridor?.width, 0.2, 2, 0.7)
      })).filter((corridor) => roomIds.has(corridor.from) && roomIds.has(corridor.to) && corridor.from !== corridor.to)
    : [];
  const objects = Array.isArray(source.objects)
    ? source.objects.slice(0, MAX_OBJECTS).map((object, index) => ({
        id: cleanId(object?.id || `object-${index + 1}`),
        type: OBJECT_TYPES.has(object?.type) ? object.type : object?.type === 'ranged' ? 'spitter' : 'stone',
        roomId: cleanId(object?.roomId),
        x: boundedNumber(object?.x, -0.46, 0.46, 0),
        y: boundedNumber(object?.y, -0.46, 0.46, 0),
        quantity: boundedInteger(object?.quantity, 1, 50, 1)
      })).filter((object) => roomIds.has(object.roomId))
    : [];
  return {
    name: cleanText(source.name || 'Untitled Mine', 60),
    background: ['deep', 'crystal', 'magma', 'ruins'].includes(source.background) ? source.background : 'deep',
    rooms,
    corridors,
    objects
  };
}

export function validateCompetitionMap(input) {
  const map = normalizeCompetitionMap(input);
  const errors = [];
  const warnings = [];
  const roomIds = new Set();
  const objectIds = new Set();
  for (const room of map.rooms) {
    if (roomIds.has(room.id)) errors.push(`Room ID "${room.id}" is duplicated.`);
    roomIds.add(room.id);
  }
  for (const object of map.objects) {
    if (objectIds.has(object.id)) errors.push(`Object ID "${object.id}" is duplicated.`);
    objectIds.add(object.id);
  }
  const starts = map.rooms.filter((room) => room.type === 'start');
  const guardians = map.rooms.filter((room) => room.type === 'guardian');
  if (starts.length !== 1) errors.push('The map must have exactly one start room.');
  if (guardians.length !== 1) errors.push('The map must have exactly one Guardian room.');
  const playerSpawns = map.objects.filter((object) => object.type === 'player');
  const bosses = map.objects.filter((object) => object.type === 'guardian');
  const extraction = map.objects.filter((object) => object.type === 'extraction');
  if (playerSpawns.length !== 1) errors.push('Place exactly one player spawn.');
  if (bosses.length < 1) errors.push('Place at least one Guardian.');
  if (extraction.length !== 1) errors.push('Place exactly one extraction lift.');
  if (playerSpawns[0] && starts[0] && playerSpawns[0].roomId !== starts[0].id) {
    errors.push('The player spawn must be inside the start room.');
  }
  if (bosses.some((boss) => !guardians.some((room) => room.id === boss.roomId))) {
    errors.push('Every Guardian must be inside the Guardian room.');
  }
  if (map.rooms.length) {
    const graph = new Map(map.rooms.map((room) => [room.id, new Set()]));
    for (const corridor of map.corridors) {
      graph.get(corridor.from)?.add(corridor.to);
      graph.get(corridor.to)?.add(corridor.from);
    }
    const reached = new Set();
    const queue = starts[0] ? [starts[0].id] : [];
    while (queue.length) {
      const id = queue.shift();
      if (reached.has(id)) continue;
      reached.add(id);
      queue.push(...(graph.get(id) || []));
    }
    const unreachable = map.rooms.filter((room) => !reached.has(room.id));
    if (unreachable.length) errors.push(`Unreachable rooms: ${unreachable.map((room) => room.name).join(', ')}.`);
  }
  for (let a = 0; a < map.rooms.length; a += 1) {
    for (let b = a + 1; b < map.rooms.length; b += 1) {
      if (roomsOverlap(map.rooms[a], map.rooms[b])) {
        errors.push(`${map.rooms[a].name} overlaps ${map.rooms[b].name}.`);
      }
    }
  }
  const spawnRoomEnemies = map.objects.filter((object) =>
    object.roomId === starts[0]?.id && MAP_OBJECT_KINDS.enemy.includes(object.type)
  );
  if (spawnRoomEnemies.length) warnings.push('The start room contains enemies; safe-start rules will delay their attacks.');
  if (!map.objects.some((object) => MAP_OBJECT_KINDS.loot.includes(object.type))) {
    warnings.push('This mine has no placed loot or weapon boxes.');
  }
  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      rooms: map.rooms.length,
      corridors: map.corridors.length,
      objects: map.objects.length,
      enemies: map.objects.filter((object) => MAP_OBJECT_KINDS.enemy.includes(object.type) || object.type === 'guardian').length,
      loot: map.objects.filter((object) => MAP_OBJECT_KINDS.loot.includes(object.type)).length
    },
    map
  };
}

export function resolveCompetitionSnapshot(studioInput, slotId, timestamp = Date.now()) {
  const studio = normalizeCompetitionStudio(studioInput, timestamp);
  const slot = studio.slots[slotId];
  if (!slot) return null;
  const candidates = Object.values(studio.snapshots)
    .filter((snapshot) =>
      snapshot.slotId === slotId &&
      snapshot.effectiveAt <= timestamp &&
      (!snapshot.expiresAt || snapshot.expiresAt > timestamp)
    )
    .sort((a, b) =>
      b.effectiveAt - a.effectiveAt ||
      b.publishedAt - a.publishedAt ||
      Number(b.id === slot.activeSnapshotId) - Number(a.id === slot.activeSnapshotId)
    );
  const snapshot = candidates[0] || null;
  return snapshot ? { ...structuredClone(snapshot), status: 'live' } : null;
}

export function materializeCompetitionMap(input) {
  const map = normalizeCompetitionMap(input);
  const rooms = map.rooms.map((room, index) => ({
    id: index + 1,
    sourceId: room.id,
    cellX: room.x,
    cellY: room.y,
    x: 180 + room.x * 185,
    y: 150 + room.y * 180,
    width: room.width * 170,
    height: room.height * 155,
    parent: null,
    type: room.type,
    name: room.name
  }));
  const bySource = new Map(rooms.map((room) => [room.sourceId, room]));
  const corridors = map.corridors.map((corridor) => {
    const a = bySource.get(corridor.from);
    const b = bySource.get(corridor.to);
    const width = Math.max(70, corridor.width * 120);
    if (Math.abs(a.x - b.x) >= Math.abs(a.y - b.y)) {
      return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, width: Math.abs(a.x - b.x) + width, height: width, orientation: 'horizontal' };
    }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, width, height: Math.abs(a.y - b.y) + width, orientation: 'vertical' };
  });
  const positionedObjects = map.objects.map((object) => {
    const room = bySource.get(object.roomId);
    return {
      ...object,
      roomId: room.id,
      x: room.x + object.x * room.width,
      y: room.y + object.y * room.height
    };
  });
  return {
    rooms,
    corridors,
    startRoom: rooms.find((room) => room.type === 'start') || rooms[0],
    guardianRoom: rooms.find((room) => room.type === 'guardian') || rooms.at(-1),
    treasureRoom: rooms.find((room) => room.type === 'treasure') || null,
    objects: positionedObjects,
    source: map
  };
}

export function competitionSlotForMode(mode) {
  return COMPETITION_SLOTS.find((slot) => slot.mode === mode)?.id || '';
}

export function createStarterMap(slotId, depth = 1) {
  const depthIndex = Math.max(0, Math.min(COMPETITION_DEPTH_COUNT - 1, Math.floor(Number(depth) || 1) - 1));
  const branchOffset = (depthIndex % 3 - 1) * 0.3;
  const rooms = [
    room('lift', 1, 3, 2, 2, 'start', 'Lift Station'),
    room('vein', 3, 3, 2, 2, 'mining', 'Crystal Vein'),
    room('crossing', 5, 3, 2, 2, 'combat', 'Broken Crossing'),
    room('cache', 5, 1 - Math.abs(branchOffset), 2, 1.7, 'treasure', 'Prospector Cache'),
    room('works', 7, 3, 2, 2, 'mixed', 'Old Workings'),
    room('nest', 7, 5 + Math.abs(branchOffset), 2, 1.7, 'combat', 'Crawler Nest'),
    room('vault', 9.5, 3 + branchOffset, 2.4, 2.4, 'guardian', 'Guardian Vault')
  ];
  const links = [['lift', 'vein'], ['vein', 'crossing'], ['crossing', 'cache'], ['crossing', 'works'], ['works', 'nest'], ['works', 'vault']];
  const objects = [
    object('player', 'lift', 0, 0),
    object('extraction', 'lift', -0.3, 0),
    object('crystal', 'vein', -0.2, -0.2, 4),
    object('gold', 'vein', 0.25, 0.18, 3),
    object(depthIndex >= 3 ? 'exploder' : 'slime', 'crossing', -0.2, 0, 2 + Math.floor(depthIndex / 2)),
    object('beetle', 'crossing', 0.25, 0.12),
    object('treasure', 'cache', 0, 0),
    object('weapon_blaster', 'cache', 0.25, 0),
    object('copper', 'works', -0.2, 0.18, 4),
    object('crawler', 'nest', -0.15, 0, 3 + depthIndex),
    object('spitter', 'nest', 0.28, -0.1),
    object('guardian', 'vault', 0.15, 0),
    object('health', 'vault', -0.3, 0.25)
  ];
  return {
    name: `${COMPETITION_SLOTS.find((slot) => slot.id === slotId)?.name || 'MATT'} · Depth ${depthIndex + 1}`,
    background: depthIndex >= 4 ? 'ruins' : depthIndex >= 2 ? 'crystal' : slotId === 'pass' ? 'crystal' : slotId === 'weekly' ? 'ruins' : slotId === 'arena' ? 'magma' : 'deep',
    rooms,
    corridors: links.map(([from, to], index) => ({ id: `path-${index + 1}`, from, to, width: 0.75 })),
    objects
  };
}

function createStarterDepths(slotId) {
  return Array.from({ length: COMPETITION_DEPTH_COUNT }, (_, index) => ({
    depth: index + 1,
    map: createStarterMap(slotId, index + 1)
  }));
}

function createBootstrapSnapshot(draft) {
  const id = `bootstrap_${draft.slotId}_v1`;
  return {
    ...structuredClone(draft),
    id,
    status: 'live',
    effectiveAt: 0,
    expiresAt: 0,
    publishedAt: 0,
    publishedBy: 'SYSTEM_BOOTSTRAP',
    fingerprint: id
  };
}

function defaultLoadout() {
  return {
    characterId: 'matt',
    startingWeapon: 'pickaxe',
    availableWeapons: ['pickaxe', 'dynamite', 'blaster'],
    startingHealth: 100,
    startingDynamite: 0,
    blasterEnergy: 115,
    permanentUpgrades: true,
    runUpgrades: true,
    maximumDrones: 4,
    paidRevive: false
  };
}

function normalizeLoadout(input) {
  const source = isRecord(input) ? input : {};
  const weapons = ['pickaxe', 'dynamite', 'blaster'];
  const availableWeapons = Array.isArray(source.availableWeapons)
    ? [...new Set(source.availableWeapons.filter((weapon) => weapons.includes(weapon)))]
    : [...weapons];
  if (!availableWeapons.includes('pickaxe')) availableWeapons.unshift('pickaxe');
  const requestedCharacterId = cleanId(source.characterId || 'matt');
  return {
    characterId: CHARACTER_IDS.includes(requestedCharacterId) ? requestedCharacterId : 'matt',
    startingWeapon: availableWeapons.includes(source.startingWeapon) ? source.startingWeapon : 'pickaxe',
    availableWeapons,
    startingHealth: boundedNumber(source.startingHealth, 1, 1000, 100),
    startingDynamite: boundedInteger(source.startingDynamite, 0, 99, 0),
    blasterEnergy: boundedNumber(source.blasterEnergy, 1, 1000, 115),
    permanentUpgrades: source.permanentUpgrades !== false,
    runUpgrades: source.runUpgrades !== false,
    maximumDrones: boundedInteger(source.maximumDrones, 0, 4, 4),
    paidRevive: source.paidRevive === true
  };
}

function defaultSlotRules(slotId) {
  return {
    scoring: slotId === 'weekly' ? 'cumulative' : 'best',
    attemptLimit: slotId === 'practice' || slotId === 'arena' ? 0 : slotId === 'pass' ? 10 : 1,
    safeStartSeconds: 4,
    leaderboardTitle: `${COMPETITION_SLOTS.find((slot) => slot.id === slotId)?.name || 'Mine'} Leaderboard`,
    rewardLabel: slotId === 'practice' ? 'No rewards' : 'Server-verified rewards',
    instructions: 'Beat the Guardian, bank the most nuggets, and return to the lift.'
  };
}

function normalizeRules(input, slotId) {
  const source = isRecord(input) ? input : {};
  const defaults = defaultSlotRules(slotId);
  return {
    scoring: ['best', 'cumulative'].includes(source.scoring) ? source.scoring : defaults.scoring,
    attemptLimit: boundedInteger(source.attemptLimit, 0, 1000, defaults.attemptLimit),
    safeStartSeconds: boundedNumber(source.safeStartSeconds, 0, 30, defaults.safeStartSeconds),
    leaderboardTitle: cleanText(source.leaderboardTitle || defaults.leaderboardTitle, 70),
    rewardLabel: cleanText(source.rewardLabel || defaults.rewardLabel, 100),
    instructions: cleanText(source.instructions || defaults.instructions, 220)
  };
}

function normalizeRoom(input, index) {
  const room = isRecord(input) ? input : {};
  return {
    id: cleanId(room.id || `room-${index + 1}`),
    x: boundedNumber(room.x, 0, 11, Math.min(11, index + 1)),
    y: boundedNumber(room.y, 0, 7, 3),
    width: boundedNumber(room.width, 1, 3.5, 2),
    height: boundedNumber(room.height, 1, 3, 2),
    type: ROOM_TYPES.has(room.type) ? room.type : 'mixed',
    name: cleanText(room.name || 'Mine Room', 40)
  };
}

function room(id, x, y, width, height, type, name) {
  return { id, x, y, width, height, type, name };
}

function object(type, roomId, x, y, quantity = 1) {
  return { id: `${type}-${roomId}`, type, roomId, x, y, quantity };
}

function roomsOverlap(a, b) {
  const padding = 0.15;
  return Math.abs(a.x - b.x) < (a.width + b.width) / 2 - padding &&
    Math.abs(a.y - b.y) < (a.height + b.height) / 2 - padding;
}

function defaultSubtitle(slotId) {
  return {
    practice: 'Learn the mine with no risk.',
    arena: 'Unlimited MATT entries. Best verified score wins.',
    daily: 'One free official attempt on today’s handcrafted map.',
    pass: 'Premium competition for active Mine Pass holders.',
    weekly: 'Seven days. One championship mine.',
    pvp: 'Competitive multiplayer is in development.'
  }[slotId] || '';
}

function cleanText(value, max) {
  return String(value || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max);
}

function cleanId(value) {
  const id = String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 48);
  return id || 'item';
}

function boundedNumber(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function boundedInteger(value, min, max, fallback) {
  return Math.round(boundedNumber(value, min, max, fallback));
}

function safeTimestamp(value) {
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : 0;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
