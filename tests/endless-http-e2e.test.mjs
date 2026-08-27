import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryDatabase } from '../server/database.js';
import { createProductionMattMineHttpServer } from '../server/production-http.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ADDRESS = '0x1111111111111111111111111111111111111111';
const ADMIN_KEY = 'endless-e2e-admin-key';

test('Endless production HTTP routes complete one player run and enforce an Admin entry pause', async (context) => {
  context.mock.method(console, 'log', () => {});
  let timestamp = Date.UTC(2026, 7, 26, 12);
  let randomCounter = 0;
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => timestamp,
    publicOrigin: null,
    adminKey: ADMIN_KEY,
    verifySignature: async () => true,
    nftGameplayService: {
      publicStatus: () => ({ enabled: true, chainId: 2020 }),
      async playerMiner(address, minerId) {
        if (address !== ADDRESS || Number(minerId) !== 7) return null;
        return {
          minerId: 7,
          owner: ADDRESS,
          progression: { bankedXp: 1_250, level: 6 },
          gameplay: { crystalCarryCapacity: 12, runLocked: false },
          traits: {
            level: 6,
            health: 150,
            damage: 20,
            armor: 4,
            speed: 1,
            luck: 1,
            crystalCarryCapacity: 12
          },
          equipped: {}
        };
      }
    },
    competitiveReplayValidator: {
      async registerEndlessPhase(run) {
        return {
          throughSeq: 0,
          throughTick: 0,
          transcriptHash: `phase-${run.currentPhase}-${run.phaseAttempt}`,
          signature: 'e2e-input-signature'
        };
      },
      async appendEndlessPhase() {
        return {
          throughSeq: 1,
          throughTick: 1_000,
          transcriptHash: 'e2e-inputs',
          signature: 'e2e-input-signature'
        };
      },
      async verifyEndlessPhase({ run }) {
        return {
          outcomeEvents: completeEvents(run.manifest),
          evidence: {
            schemaVersion: 'e2e-replay-v1',
            eventCount: 1,
            transcriptHash: 'e2e-inputs',
            runtime: {},
            rawScore: 0,
            state: 'verified'
          }
        };
      },
      async finalizeEndlessPhase() {}
    },
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  const server = createProductionMattMineHttpServer({ root: ROOT, service });
  const baseUrl = await listen(server);
  context.after(() => close(server));

  const challenge = await jsonRequest(baseUrl, '/api/auth/challenge', {
    method: 'POST',
    body: { address: ADDRESS, chainId: 2020, origin: baseUrl }
  });
  assert.equal(challenge.status, 201);
  const verification = await jsonRequest(baseUrl, '/api/auth/verify', {
    method: 'POST',
    body: {
      address: ADDRESS,
      nonce: challenge.body.challenge.nonce,
      signature: `0x${'11'.repeat(65)}`
    }
  });
  assert.equal(verification.status, 200);
  const token = verification.body.session.token;
  const playerHeaders = { authorization: `Bearer ${token}` };

  const identity = await jsonRequest(baseUrl, '/api/profile/identity', {
    method: 'POST',
    headers: playerHeaders,
    body: { name: 'EndlessE2E' }
  });
  assert.equal(identity.status, 201);

  const status = await jsonRequest(baseUrl, '/api/endless/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.endless.paidEntryEnabled, false);
  const entry = await jsonRequest(baseUrl, '/api/endless/entry/prepare', {
    method: 'POST',
    headers: playerHeaders,
    body: { minerId: 7 }
  });
  assert.equal(entry.status, 200);
  assert.equal(entry.body.entry.eligible, true);
  assert.equal(entry.body.entry.entryPriceMatt, 0);

  const started = await jsonRequest(baseUrl, '/api/runs/start', {
    method: 'POST',
    headers: playerHeaders,
    body: { mode: 'endless', minerId: 7 }
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.run.mode, 'endless');
  assert.equal(started.body.run.currentPhase, 1);

  const resumed = await jsonRequest(baseUrl, '/api/endless/resume', {
    method: 'POST',
    headers: playerHeaders,
    body: { minerId: 7 }
  });
  assert.equal(resumed.status, 200);
  assert.equal(resumed.body.run.runId, started.body.run.runId);
  assert.notEqual(resumed.body.run.runToken, started.body.run.runToken);

  timestamp += 20_000;
  const banked = await jsonRequest(baseUrl, '/api/endless/checkpoint', {
    method: 'POST',
    headers: playerHeaders,
    body: {
      runId: started.body.run.runId,
      runToken: resumed.body.run.runToken,
      previousCheckpoint: resumed.body.run.checkpoint,
      action: 'bank'
    }
  });
  assert.equal(banked.status, 200);
  assert.equal(banked.body.summary.status, 'banked');
  assert.equal(banked.body.phase.integrity, 'verified');

  const player = await jsonRequest(baseUrl, '/api/endless/player', { headers: playerHeaders });
  assert.equal(player.status, 200);
  assert.equal(player.body.player.lifetime.totalRuns, 1);
  assert.equal(player.body.player.history[0].runId, started.body.run.runId);
  const scoreBoard = await jsonRequest(
    baseUrl,
    '/api/competitions/endless/leaderboard?scope=all-time&board=score',
    { headers: playerHeaders }
  );
  const depthBoard = await jsonRequest(
    baseUrl,
    '/api/competitions/endless/leaderboard?scope=all-time&board=deepest',
    { headers: playerHeaders }
  );
  assert.equal(scoreBoard.body.leaderboard.player.rank, 1);
  assert.equal(depthBoard.body.leaderboard.player.runId, started.body.run.runId);

  const adminHeaders = { 'x-matt-admin-key': ADMIN_KEY };
  const overview = await jsonRequest(baseUrl, '/api/admin/endless', { headers: adminHeaders });
  assert.equal(overview.status, 200);
  assert.equal(overview.body.endless.monitoring.counts.completedRuns, 1);
  const paused = await jsonRequest(baseUrl, '/api/admin/endless/operations', {
    method: 'PUT',
    headers: adminHeaders,
    body: {
      patch: { newEntriesEnabled: false, leaderboardSubmissionsEnabled: false },
      reason: 'Exercise production HTTP pause propagation.'
    }
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.operations.newEntriesEnabled, false);

  const publicMine = await jsonRequest(baseUrl, '/api/mines/endless');
  assert.equal(publicMine.status, 200);
  assert.equal(publicMine.body.slot.entriesPaused, true);
  assert.equal(publicMine.body.leaderboard.paused, true);
  const rejectedEntry = await jsonRequest(baseUrl, '/api/endless/entry/prepare', {
    method: 'POST',
    headers: playerHeaders,
    body: { minerId: 7 }
  });
  assert.equal(rejectedEntry.body.error.code, 'endless_entries_paused');
});

function completeEvents(manifest) {
  let tick = 1_000;
  const events = [];
  for (const enemy of manifest.map.objects.filter((object) => object.classification === 'natural')) {
    events.push({ type: 'enemy_killed', targetId: enemy.id, tick: tick += 100 });
  }
  for (const ore of manifest.map.objects.filter((object) => object.classification === 'ore')) {
    events.push({ type: 'ore_broken', targetId: ore.id, tick: tick += 100 });
    if (ore.mattCrystal) {
      events.push({ type: 'crystal_collected', targetId: ore.id, tick: tick += 1 });
    }
  }
  const guardian = manifest.map.objects.find((object) => object.classification === 'boss');
  events.push({ type: 'guardian_defeated', targetId: guardian.id, tick: tick += 100 });
  events.push({ type: 'phase_completed', tick: tick += 100 });
  return events;
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

async function jsonRequest(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || 'GET',
    headers: {
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: response.status, body: await response.json() };
}
