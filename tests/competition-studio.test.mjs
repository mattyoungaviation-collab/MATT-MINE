import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  COMPETITION_DEPTH_COUNT,
  COMPETITION_SLOTS,
  competitionMapForDepth,
  defaultCompetitionStudio,
  materializeCompetitionMap,
  normalizeCompetitionDraft,
  resolveCompetitionSnapshot,
  validateCompetitionMap
} from '../src/game/competitionStudio.js';
import { defaultProfile } from '../src/game/storage.js';
import { MemoryDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';
import { buildCompetitiveChallenge, competitiveMaximumDepth } from '../server/arena-engine.js';
import { defaultWalletState, normalizeServerState } from '../server/state.js';
import { SERVER_STATE_VERSION } from '../server/constants.js';

const NOW = Date.UTC(2026, 6, 28, 18, 0, 0);

test('Competition Studio owns five playable slots and keeps PvP visibly locked', () => {
  const studio = defaultCompetitionStudio(NOW);
  assert.deepEqual(COMPETITION_SLOTS.map((slot) => slot.id), [
    'practice', 'arena', 'daily', 'pass', 'weekly', 'pvp'
  ]);
  for (const slot of COMPETITION_SLOTS.filter((entry) => !entry.comingSoon)) {
    const draft = studio.slots[slot.id].draft;
    assert.equal(draft.depths.length, COMPETITION_DEPTH_COUNT);
    for (const depth of draft.depths) {
      const validation = validateCompetitionMap(depth.map);
      assert.equal(validation.valid, true, validation.errors.join('\n'));
      assert.equal(depth.map.objects.filter((object) => object.type === 'player').length, 1);
      assert.equal(depth.map.objects.filter((object) => object.type === 'extraction').length, 1);
      assert.ok(depth.map.objects.some((object) => object.type === 'guardian'));
    }
  }
  assert.equal(COMPETITION_SLOTS.at(-1).comingSoon, true);
});

test('state migration adds safe Competition Studio drafts without disturbing legacy data', () => {
  const address = '0x1111111111111111111111111111111111111111';
  const migrated = normalizeServerState({
    version: 12,
    wallets: {
      [address]: {
        ...defaultWalletState(address, NOW),
        profile: { ...defaultProfile(), bankedNuggets: 42 }
      }
    }
  });
  assert.equal(migrated.version, SERVER_STATE_VERSION);
  assert.equal(Object.keys(migrated.competitionStudio.slots).length, 6);
  assert.equal(migrated.competitionStudio.slots.practice.draft.slotId, 'practice');
  assert.equal(migrated.competitionStudio.slots.practice.draft.depths.length, 5);
  assert.ok(migrated.wallets[address]);
});

test('legacy single maps migrate to five independently editable depth maps', () => {
  const source = structuredClone(defaultCompetitionStudio(NOW).slots.daily.draft);
  delete source.depths;
  source.map.name = 'Legacy Daily Layout';
  const normalized = normalizeCompetitionDraft(source, 'daily');
  assert.equal(normalized.depths.length, 5);
  assert.equal(competitionMapForDepth(normalized, 1).name, 'Legacy Daily Layout');
  assert.match(competitionMapForDepth(normalized, 5).name, /Depth 5/);
  normalized.depths[1].map.rooms[0].x = 2.5;
  assert.notEqual(normalized.depths[0].map.rooms[0].x, normalized.depths[1].map.rooms[0].x);
});

test('map validation blocks disconnected objectives, duplicate spawns, and overlapping rooms', () => {
  const draft = structuredClone(defaultCompetitionStudio(NOW).slots.daily.draft);
  draft.map.corridors = [];
  draft.map.objects.push({ ...draft.map.objects[0], id: 'second-player' });
  draft.map.rooms[1].x = draft.map.rooms[0].x;
  draft.map.rooms[1].y = draft.map.rooms[0].y;
  const validation = validateCompetitionMap(draft.map);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('exactly one player spawn')));
  assert.ok(validation.errors.some((error) => error.includes('Unreachable rooms')));
  assert.ok(validation.errors.some((error) => error.includes('overlaps')));
});

test('published competition snapshots are scheduled, immutable, and selected by server time', async () => {
  let randomCounter = 0;
  const database = new MemoryDatabase();
  const service = new MattMineService(database, {
    now: () => NOW,
    chainId: 2020,
    adminKey: 'competition-admin',
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0');
    }
  });
  const overview = await service.adminCompetitionStudio('competition-admin');
  const draft = structuredClone(overview.studio.slots.daily.draft);
  draft.name = 'Tomorrow’s Crystal Gauntlet';
  draft.map.name = 'Crystal Gauntlet Layout';
  await service.saveCompetitionDraft(
    'competition-admin',
    'daily',
    draft,
    'Prepare tomorrow’s official competition.'
  );
  const effectiveAt = NOW + 60_000;
  const published = await service.publishCompetitionSnapshot('competition-admin', 'daily', {
    effectiveAt,
    expiresAt: effectiveAt + 86_400_000,
    reason: 'Publish the reviewed daily map.'
  });
  assert.match(published.snapshot.id, /^snapshot_daily_/);
  assert.match(published.snapshot.fingerprint, /^[a-f0-9]{64}$/);
  const state = await database.read();
  assert.notEqual(resolveCompetitionSnapshot(state.competitionStudio, 'daily', NOW).id, published.snapshot.id);
  assert.equal(resolveCompetitionSnapshot(state.competitionStudio, 'daily', effectiveAt).id, published.snapshot.id);
  assert.equal(
    resolveCompetitionSnapshot(state.competitionStudio, 'daily', effectiveAt + 86_400_000).id,
    'default-daily'
  );

  const changed = normalizeCompetitionDraft({
    ...draft,
    name: 'Later Draft'
  }, 'daily');
  await service.saveCompetitionDraft('competition-admin', 'daily', changed, 'Start a later draft.');
  const after = await database.read();
  assert.equal(after.competitionStudio.snapshots[published.snapshot.id].name, 'Tomorrow’s Crystal Gauntlet');
});

test('authored maps materialize exact player, Guardian, extraction, loot, and hazard positions', async () => {
  installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const draft = structuredClone(defaultCompetitionStudio(NOW).slots.practice.draft);
  draft.depths[0].map.objects.push({
    id: 'rockfall-test',
    type: 'rockfall',
    roomId: 'crossing',
    x: 0.1,
    y: -0.15,
    quantity: 1
  });
  draft.depths[1].map.name = 'Independent Depth Two';
  draft.depths[1].map.rooms.find((room) => room.id === 'lift').x = 2.5;
  draft.depths[3].map.name = 'Published Depth Four';
  draft.depths[4].map.name = 'Published Depth Five';
  const snapshot = {
    ...draft,
    map: draft.depths[0].map,
    id: 'snapshot-practice-test',
    status: 'live',
    fingerprint: 'a'.repeat(64)
  };
  const materialized = materializeCompetitionMap(snapshot.map);
  const guardianPlacement = materialized.objects.find((object) => object.type === 'guardian');
  const extractionPlacement = materialized.objects.find((object) => object.type === 'extraction');
  const canvas = browserCanvas();
  const game = new MattMineGame(canvas, defaultProfile(), { headless: true });
  game.startRun({
    mode: 'practice',
    seed: 'AUTHORED-MAP',
    tuning: { usePerDepthRoomSpawns: false, _competitionSnapshot: snapshot },
    competitionSnapshot: snapshot
  });
  assert.equal(game.layout.rooms.length, draft.map.rooms.length);
  assert.equal(game.hazards.length, 1);
  assert.equal(game.run.customExtraction.x, extractionPlacement.x);
  assert.equal(game.run.customExtraction.y, extractionPlacement.y);
  game.run.bossReady = true;
  const guardian = game.awakenGuardian(game.layout.guardianRoom);
  assert.equal(guardian.x, guardianPlacement.x);
  assert.equal(guardian.y, guardianPlacement.y);
  game.createPortal();
  assert.equal(game.portal.x, extractionPlacement.x);
  assert.equal(game.portal.y, extractionPlacement.y);

  game.run.depth = 2;
  game.generateDepth();
  assert.equal(game.layout.source.name, 'Independent Depth Two');
  assert.notEqual(
    game.layout.startRoom.cellX,
    materializeCompetitionMap(draft.depths[0].map).startRoom.cellX
  );

  game.run.depth = 4;
  game.generateDepth();
  assert.equal(game.layout.source.name, 'Published Depth Four');
  game.run.depth = 5;
  game.generateDepth();
  assert.equal(game.layout.source.name, 'Published Depth Five');
});

test('published weekly mines descend through all five authored maps before extraction', async () => {
  installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const snapshot = structuredClone(defaultCompetitionStudio(NOW).slots.weekly.draft);
  snapshot.id = 'snapshot-weekly-five-depths';
  snapshot.status = 'live';
  snapshot.fingerprint = 'b'.repeat(64);
  snapshot.depths.forEach((entry, index) => {
    entry.map.name = `Weekly Authored Depth ${index + 1}`;
  });
  snapshot.map = snapshot.depths[0].map;
  const commands = [];
  const game = new MattMineGame(browserCanvas(), defaultProfile(), {
    headless: true,
    onArenaInput(event) {
      if (event.command) commands.push(event.command);
    }
  });
  game.startRun({
    mode: 'weekly',
    seed: 'WEEKLY-FIVE-DEPTHS',
    tuning: { usePerDepthRoomSpawns: false, _competitionSnapshot: snapshot },
    competitionSnapshot: snapshot
  });

  for (let nextDepth = 2; nextDepth <= COMPETITION_DEPTH_COUNT; nextDepth += 1) {
    game.state = 'depthchoice';
    game.descend();
    assert.equal(game.run.depth, nextDepth);
    assert.equal(game.layout.source.name, `Weekly Authored Depth ${nextDepth}`);
    assert.equal(game.state, 'playing');
  }

  game.state = 'depthchoice';
  game.descend();
  assert.equal(game.state, 'ended');
  assert.deepEqual(commands, ['descend', 'descend', 'descend', 'descend', 'extract']);

  const run = {
    mode: 'weekly',
    seed: 'c'.repeat(64),
    competitionSnapshot: snapshot,
    tuning: { _competitionSnapshot: snapshot }
  };
  assert.equal(competitiveMaximumDepth(run), 5);
  assert.equal(buildCompetitiveChallenge(run).maxDepth, 5);
});

test('Admin Practice playtests begin on the selected authored depth', async () => {
  installBrowserStubs();
  const { MattMineGame } = await import('../src/game/GameV4.js');
  const snapshot = structuredClone(defaultCompetitionStudio(NOW).slots.practice.draft);
  snapshot.id = 'admin-depth-five-test';
  snapshot.status = 'test';
  snapshot.fingerprint = 'ADMIN-TEST';
  snapshot.depths[3].map.name = 'Admin Playtest Depth Four';
  snapshot.depths[4].map.name = 'Admin Playtest Depth Five';

  for (const startingDepth of [4, 5]) {
    const game = new MattMineGame(browserCanvas(), defaultProfile(), { headless: true });
    game.startRun({
      mode: 'practice',
      seed: `ADMIN-PLAYTEST-${startingDepth}`,
      startingDepth,
      tuning: { usePerDepthRoomSpawns: false, _competitionSnapshot: snapshot },
      competitionSnapshot: snapshot
    });
    assert.equal(game.run.depth, startingDepth);
    assert.equal(
      game.layout.source.name,
      startingDepth === 4 ? 'Admin Playtest Depth Four' : 'Admin Playtest Depth Five'
    );
  }

  const ordinaryPractice = new MattMineGame(browserCanvas(), defaultProfile(), { headless: true });
  ordinaryPractice.startRun({
    mode: 'practice',
    seed: 'ORDINARY-PRACTICE',
    startingDepth: 5,
    competitionSnapshot: { ...snapshot, status: 'live' }
  });
  assert.equal(ordinaryPractice.run.depth, 1, 'only explicit Admin test snapshots may skip depths');
});

test('production surfaces include the six-card hub, exact-map loading screen, and visual Admin editor', async () => {
  const [admin, main, hub, loading, productionCss, studioJs, ...mineCardAssets] = await Promise.all([
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/game/mineHub.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/game/mineLoadingScreen.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/production.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/adminCompetitionStudio.js', import.meta.url), 'utf8'),
    ...COMPETITION_SLOTS.map((slot) =>
      readFile(new URL(`../assets/game/mine-cards/${slot.id}.webp`, import.meta.url))
    )
  ]);
  assert.match(admin, /id="tab-studio"/);
  assert.match(admin, /id="studio-map-canvas"/);
  assert.match(admin, /id="studio-depth-tabs"/);
  assert.match(admin, /PUBLISH VERSION/);
  assert.match(hub, /competition-slot-grid/);
  assert.match(hub, /PvP Mine/);
  assert.match(hub, /OPEN MINE \+ BOARD/);
  assert.match(productionCss, /--mine-card-image/);
  assert.equal(mineCardAssets.length, 6);
  assert.ok(mineCardAssets.every((asset) => asset.byteLength > 20_000));
  assert.match(loading, /MINIMUM_LOADING_MS = 10_000/);
  assert.match(main, /competitionSnapshot/);
  assert.match(
    main,
    /import \{ COMPETITION_DEPTH_COUNT \} from '\.\/game\/competitionStudio\.js';/
  );
  assert.match(main, /startingDepth: testDepth/);
  assert.match(studioJs, /testDepth: studio\.depth/);
});

function installBrowserStubs() {
  globalThis.window = { addEventListener() {}, devicePixelRatio: 1 };
  globalThis.document = { querySelector() { return null; } };
  globalThis.requestAnimationFrame = () => 1;
}

function browserCanvas() {
  const gradient = { addColorStop() {} };
  const context = new Proxy({}, {
    get(target, property) {
      if (property === 'createRadialGradient' || property === 'createLinearGradient') return () => gradient;
      if (property in target) return target[property];
      return () => {};
    },
    set(target, property, value) {
      target[property] = value;
      return true;
    }
  });
  return {
    width: 1280,
    height: 720,
    style: {},
    dataset: {},
    getContext: () => context,
    addEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 1280, height: 720 })
  };
}
