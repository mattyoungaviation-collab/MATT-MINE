import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { defaultProfile } from '../src/game/storage.js';
import { CHARACTER_IDS, defaultPlayerExpansion, normalizePlayerExpansion } from '../src/game/expansionConfig.js';

const liveFiles = [
  'index.html',
  'admin.html',
  'src/main.js',
  'src/admin.js',
  'src/game/config.js',
  'src/game/storage.js',
  'server/service.js',
  'server/complete-production-service.js',
  'server/production-http.js',
  'scripts/dev-server.mjs'
];

test('the retired browser currency and its permanent shop are absent from live application surfaces', async () => {
  for (const file of liveFiles) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /nugget/i, file);
    assert.doesNotMatch(source, /permanent[ -]?upgrade/i, file);
  }
});

test('game profiles no longer contain a spendable balance or permanent stat ranks', () => {
  assert.deepEqual(defaultProfile(), { bestDepth: 0, bestScore: 0, totalRuns: 0 });
});

test('all legacy character choices remain available without a currency purchase', () => {
  assert.deepEqual(defaultPlayerExpansion().ownedCharacters, [...CHARACTER_IDS]);
  assert.deepEqual(normalizePlayerExpansion({ ownedCharacters: ['matt'] }).ownedCharacters, [...CHARACTER_IDS]);
});
