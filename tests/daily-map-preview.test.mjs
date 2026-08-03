import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DAILY_MINE_PREVIEW_FLOOR_ART,
  createDailyMinePreviewModel,
  freeDailyMineSeed
} from '../src/game/dailyMapPreview.js';

test('daily mine preview uses the exact Free ranked seed and deterministic depth-one layout', () => {
  const first = createDailyMinePreviewModel('2026-07-26');
  const repeated = createDailyMinePreviewModel('2026-07-26');
  const tomorrow = createDailyMinePreviewModel('2026-07-27');

  assert.equal(first.seed, 'MATT-MINE-2026-07-26-FREE');
  assert.equal(freeDailyMineSeed('2026-07-26'), first.seed);
  assert.deepEqual(first, repeated);
  assert.notDeepEqual(first.rooms, tomorrow.rooms);
  assert.equal(first.rooms.length, 7);
  assert.equal(first.corridors.length, 6);
  assert.deepEqual(
    new Set(first.rooms.map((room) => room.type)),
    new Set(['start', 'guardian', 'treasure', 'mining', 'combat'])
  );
});

test('daily preview applies the same room tuning and boss enlargement as live Free runs', () => {
  const preview = createDailyMinePreviewModel('2026-07-26', {
    roomWidth: 500,
    roomHeight: 360,
    corridorWidth: 150,
    bossRoomWidth: 900,
    bossRoomHeight: 700
  });
  const boss = preview.rooms.find((room) => room.type === 'guardian');

  assert.equal(preview.rooms.find((room) => room.type === 'start').width, 500);
  assert.equal(preview.corridors[0].height === 150 || preview.corridors[0].width === 150, true);
  assert.equal(boss.width, 900);
  assert.equal(boss.height, 700);
});

test('production lobby mounts a real canvas preview with the cinematic mine floor', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/game/dailyMapPreview.js', import.meta.url), 'utf8');

  assert.equal((html.match(/data-daily-mine-preview/g) || []).length, 3);
  assert.match(html, /ACTUAL FREE DAILY MAP/);
  assert.doesNotMatch(html, /mine-route-shadow/);
  assert.equal(DAILY_MINE_PREVIEW_FLOOR_ART, '/assets/game/mine-floor-cinematic.webp');
  assert.match(source, /createMineLayout/);
});
