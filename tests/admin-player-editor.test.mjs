import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

import { AdminMattMineService } from '../server/admin-service.js';
import { MemoryDatabase } from '../server/database.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 6, 27, 3, 0, 0);
const PRIVATE_KEY = '0x1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const account = privateKeyToAccount(PRIVATE_KEY);

function harness() {
  let timestamp = START;
  let counter = 0;
  const database = new MemoryDatabase();
  const service = new AdminMattMineService(database, {
    now: () => timestamp,
    publicOrigin: ORIGIN,
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    randomHex(bytes) {
      counter += 1;
      return counter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return { database, service, advance(ms) { timestamp += ms; } };
}

async function signIn(service) {
  const challenge = await service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  const session = await service.verifyChallenge({ address: account.address, nonce: challenge.nonce, signature });
  await service.setPlayerIdentity(session.token, { name: 'BetaMiner' });
  return session;
}

test('admin can exactly edit or remove all mutable player progression with an audit trail', async () => {
  const { service } = harness();
  await signIn(service);
  const address = account.address.toLowerCase();

  const result = await service.adminAwardPlayer(
    'admin-secret',
    address,
    {
      type: 'state_patch',
      patch: {
        identity: { name: 'EditedMiner', clearAvatar: true },
        profile: {
          bankedNuggets: 777,
          bestDepth: 5,
          bestScore: 12345,
          totalRuns: 9,
          meta: {
            health: 4,
            damage: 3,
            speed: 2,
            luck: 1,
            magnet: 5,
            armor: 6,
            dash: 7,
            blaster: 8
          }
        },
        pass: {
          xp: 900,
          claimedLevels: [1, 2],
          cosmetics: ['starter_badge', 'gold_trail'],
          equipped: { badge: 'starter_badge', trail: 'gold_trail' },
          chestAvailable: 3,
          chestOpened: 2,
          chestLastOpenedAt: START
        },
        daily: { freeRunUsedToday: true }
      },
      reason: 'Beta progression calibration'
    },
    'Beta progression calibration'
  );

  assert.equal(result.wallet.identity.name, 'EditedMiner');
  assert.equal(result.wallet.profile.bankedNuggets, 777);
  assert.equal(result.wallet.profile.meta.armor, 6);
  assert.equal(result.wallet.passProgress.xp, 900);
  assert.deepEqual(result.wallet.passInventory.claimedLevels, [1, 2]);
  assert.deepEqual(result.wallet.passInventory.cosmetics, ['starter_badge', 'gold_trail']);
  assert.equal(result.wallet.passInventory.equipped.trail, 'gold_trail');
  assert.equal(result.wallet.passInventory.chests.season_one_pass_chest.available, 3);
  assert.equal(result.wallet.freeRunUsedToday, true);
  assert.ok(result.editor.metaUpgrades.some((upgrade) => upgrade.id === 'blaster'));
  assert.ok(result.editor.passRewards.some((reward) => reward.name === 'Gold Trail'));

  const detail = await service.adminWallet('admin-secret', address);
  assert.ok(detail.activity.some((entry) => entry.action === 'ADMIN_STATE_EDIT'));
  const audit = await service.adminAudit('admin-secret', { action: 'PLAYER_STATE_EDITED' });
  assert.equal(audit.entries.length, 1);
  assert.match(audit.entries[0].details, /Beta progression calibration/);
});

test('beta reset actions can zero nuggets, remove achievements, reset upgrades, and restore base progression', async () => {
  const { service } = harness();
  await signIn(service);
  const address = account.address.toLowerCase();

  await service.adminAwardPlayer('admin-secret', address, {
    type: 'state_patch',
    patch: {
      profile: { bankedNuggets: 5000, meta: { health: 10, armor: 10, blaster: 10 } },
      pass: {
        xp: 5000,
        claimedLevels: [1, 2, 3, 4],
        cosmetics: ['starter_badge', 'gold_trail'],
        equipped: { badge: 'starter_badge', trail: 'gold_trail' }
      }
    },
    reason: 'Prepare reset regression'
  }, 'Prepare reset regression');

  let reset = await service.adminAwardPlayer('admin-secret', address, {
    type: 'state_patch',
    patch: {
      profile: { bankedNuggets: 0 },
      reset: { upgrades: true, achievements: true, cosmetics: true }
    },
    reason: 'Test clean new-player combat'
  }, 'Test clean new-player combat');

  assert.equal(reset.wallet.profile.bankedNuggets, 0);
  assert.ok(Object.values(reset.wallet.profile.meta).every((rank) => rank === 0));
  assert.deepEqual(reset.wallet.passInventory.claimedLevels, []);
  assert.deepEqual(reset.wallet.passInventory.cosmetics, []);
  assert.ok(Object.values(reset.wallet.passInventory.equipped).every((id) => id === ''));
  assert.equal(reset.wallet.passProgress.xp, 5000, 'achievement removal is independent from Pass XP');

  reset = await service.adminAwardPlayer('admin-secret', address, {
    type: 'state_patch',
    patch: { reset: { allProgress: true } },
    reason: 'Return complete beta profile to baseline'
  }, 'Return complete beta profile to baseline');

  assert.equal(reset.wallet.profile.bankedNuggets, 0);
  assert.equal(reset.wallet.profile.bestDepth, 0);
  assert.equal(reset.wallet.passProgress.xp, 0);
  assert.deepEqual(reset.wallet.passInventory.claimedLevels, []);
  assert.equal(reset.wallet.freeRunUsedToday, false);
  assert.equal(reset.wallet.identity.name, 'BetaMiner', 'identity is preserved by progression resets');
});

test('player edits are blocked during an active run so a live run cannot change underneath the player', async () => {
  const { service } = harness();
  const session = await signIn(service);
  await service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);

  await assert.rejects(
    () => service.adminAwardPlayer('admin-secret', account.address, {
      type: 'state_patch',
      patch: { reset: { upgrades: true } },
      reason: 'Attempt while active'
    }, 'Attempt while active'),
    (error) => error.code === 'player_state_active_run'
  );
});

test('the command center loads a complete editor with exact fields and destructive reset tools', async () => {
  const [html, script, tuning] = await Promise.all([
    readFile(`${ROOT}admin.html`, 'utf8'),
    readFile(`${ROOT}src/adminPlayerEditor.js`, 'utf8'),
    readFile(`${ROOT}src/game/tuning.js`, 'utf8')
  ]);

  assert.match(html, /adminPlayerEditor\.js/);
  assert.match(html, /Search all controls/);
  assert.match(html, /Filter this page/);
  assert.match(script, /Save exact player state/);
  assert.match(script, /Reset permanent upgrades/);
  assert.match(script, /Zero nuggets/);
  assert.match(script, /Clear Pass achievements/);
  assert.match(script, /Reset all off-chain progression/);
  assert.match(tuning, /Focused Core damage per level/);
  assert.match(tuning, /GuardianBosses/);
});
