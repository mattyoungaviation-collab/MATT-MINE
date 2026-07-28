import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  LINKED_ADMIN_CONTROL_GROUPS,
  buildAdminControlIndex,
  searchAdminControls
} from '../src/adminControlRegistry.js';
import { GAME_TUNING_SCHEMA } from '../src/game/tuning.js';
import {
  EXPANSION_SCHEMA,
  defaultExpansionConfig
} from '../src/game/expansionConfig.js';
import {
  applyEconomyLinksToExpansion,
  applyExpansionLinksToTuning,
  applyTuningLinksToExpansion,
  economyShadowPatch,
  linkedAdminControlSnapshot
} from '../server/admin-control-links.js';
import { buildAdminReadiness } from '../server/admin-readiness.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryDatabase } from '../server/database.js';
import {
  MemoryNuggetEconomyStore,
  defaultNuggetEconomyState
} from '../server/nugget-economy.js';
import { defaultServerState } from '../server/state.js';

test('global Admin search indexes every schema and finds deeply nested balance controls', () => {
  assert.equal(
    new Set(GAME_TUNING_SCHEMA.map((entry) => entry.id)).size,
    GAME_TUNING_SCHEMA.length,
    'Every game tuning control must have one unique internal ID.'
  );
  const characters = defaultExpansionConfig().characters;
  const index = buildAdminControlIndex({
    tuningSchema: GAME_TUNING_SCHEMA,
    expansionSchema: EXPANSION_SCHEMA,
    characters
  });
  assert.ok(index.length > GAME_TUNING_SCHEMA.length + EXPANSION_SCHEMA.length);
  assert.equal(new Set(index.map((entry) => entry.id)).size, index.length);

  const enemy = searchAdminControls(index, 'depth 3 beetle health');
  assert.equal(enemy[0].tab, 'tuning');
  assert.match(enemy[0].label, /Beetle.*health/i);

  const revive = searchAdminControls(index, 'paid revive');
  assert.ok(revive.some((entry) => entry.tab === 'expansion'));

  const claims = searchAdminControls(index, 'pause claims');
  assert.equal(claims[0].tab, 'operations');

  assert.equal(searchAdminControls(index, 'competition map builder')[0].id, 'studio:maps');
  assert.equal(searchAdminControls(index, 'daily purchase cap')[0].id, 'economy:daily-cap');
  assert.equal(searchAdminControls(index, 'arena treasury seed')[0].id, 'arena:seed');
  assert.equal(searchAdminControls(index, 'player award')[0].id, 'players:award');
});

test('linked Admin controls have one canonical value and synchronize in both directions', () => {
  const state = defaultServerState();
  const economy = defaultNuggetEconomyState().config;

  const tuningChanges = applyTuningLinksToExpansion(state, 'free', { deathKeepFraction: 0.72 }, 100);
  assert.equal(state.expansionConfig.settings.deathRetentionFree, 72);
  assert.equal(tuningChanges.length, 1);

  state.expansionConfig.settings.deathRetentionPaid = 61;
  applyExpansionLinksToTuning(state);
  assert.equal(state.gameTuning.paid.deathKeepFraction, 0.61);

  economy.advertisementRewardsEnabled = true;
  economy.characterUnlockPrices.ronke = 875_000;
  const economyChanges = applyEconomyLinksToExpansion(state, economy, 200);
  assert.equal(state.expansionConfig.settings.advertisementRewardsEnabled, true);
  assert.equal(state.expansionConfig.characters.ronke.nuggetPrice, 875_000);
  assert.ok(economyChanges.length >= 2);

  const shadows = economyShadowPatch(state.expansionConfig);
  assert.equal(shadows.advertisementRewardsEnabled, true);
  assert.equal(shadows.characterUnlockPrices.ronke, 875_000);

  const snapshot = linkedAdminControlSnapshot(state, shadows);
  assert.equal(snapshot.consistent, true);
  assert.equal(snapshot.groups.length, LINKED_ADMIN_CONTROL_GROUPS.length);
});

test('production service updates knockout retention and character prices without control drift', async () => {
  const database = new MemoryDatabase();
  const nuggetEconomyStore = new MemoryNuggetEconomyStore();
  const service = new CompleteProductionMattMineService(database, {
    adminKey: 'admin-command-center-test',
    nuggetEconomyStore,
    now: () => 1_800_000_000_000
  });

  await service.ensureAdminControlLinks();
  await service.updateAdminGameTuning(
    'admin-command-center-test',
    'practice',
    { deathKeepFraction: 0.64 },
    'Linked retention test'
  );
  let state = await database.read();
  assert.equal(state.expansionConfig.settings.deathRetentionPractice, 64);

  await service.updateAdminExpansion(
    'admin-command-center-test',
    {
      settings: { deathRetentionFree: 73 },
      characters: { axie: { nuggetPrice: 654_321 } }
    },
    'Linked expansion test'
  );
  state = await database.read();
  const economy = await nuggetEconomyStore.read();
  assert.equal(state.gameTuning.free.deathKeepFraction, 0.73);
  assert.equal(state.expansionConfig.characters.axie.nuggetPrice, 654_321);
  assert.equal(economy.config.characterUnlockPrices.axie, 654_321);
  assert.equal(linkedAdminControlSnapshot(state, economy.config).consistent, true);
});

test('readiness monitor separates required blockers from optional feature blockers', () => {
  const ready = buildAdminReadiness({
    checkedAt: 123,
    database: { ok: true, kind: 'postgresql', latencyMs: 4 },
    payments: { live: true, pass: { paused: false }, paidRuns: { paused: false } },
    rewards: { available: true, publicationEnabled: true, maxBoardMatt: 5_000_000 },
    replay: { configured: true, enabled: true, verification: 'fixed-step', modes: ['free', 'paid'] },
    arena: { configured: true, enabled: true, deploymentPinned: true, replayReady: true },
    nuggetPayments: { configured: true, enabled: true },
    revive: { configured: false, enabled: false, eligibilityReady: false },
    advertisements: { configured: false, enabled: false },
    treasurySafe: { address: '0xbace355d23d378a6e1add986e53a18dd12e6eeac', owners: 3, threshold: 1 },
    controlLinks: { consistent: true, synchronizedCount: 8, conflictCount: 0 }
  });
  assert.equal(ready.status, 'ready');
  assert.equal(ready.blockedRequired, 0);
  assert.ok(ready.monitors.some((entry) => entry.id === 'paid-revives' && entry.status === 'blocked' && !entry.required));

  const blocked = buildAdminReadiness({
    database: { ok: false, kind: 'postgresql' },
    controlLinks: { consistent: false, conflictCount: 2 },
    treasurySafe: {}
  });
  assert.equal(blocked.status, 'blocked');
  assert.ok(blocked.blockedRequired >= 2);
});

test('Admin page has one organized control suite with unique element identifiers', async () => {
  const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('../admin.css', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="control-search"/);
  assert.match(html, /id="readiness-monitors"/);
  assert.match(html, /id="tab-nugget-economy"/);
  assert.match(html, /data-linked-control="advertisement-rewards-enabled"/);
  assert.match(css, /#dashboard\s*\{[\s\S]*grid-template-columns:\s*235px/);
  assert.match(css, /\.search-results/);
  assert.match(css, /\.readiness-monitor/);
  assert.doesNotMatch(css, /\.save-bar\s*\{[^}]*position:\s*sticky/s);
});
