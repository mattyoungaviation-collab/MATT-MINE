import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';
import {
  CONSUMABLE_TREASURY_ADDRESS,
  MATT_CRYSTAL_TOKEN_ADDRESS,
  defaultConsumablesEconomy,
  defaultWalletConsumables,
  validateConsumableLoadout
} from '../src/game/consumables.js';
import { ConsumableCrystalPaymentVerifier } from '../server/consumable-payment-verifier.js';
import { MemoryDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';
import { defaultWalletState } from '../server/state.js';

const NOOP_AUDIO = { startMusic() {}, stopMusic() {}, resume() {}, play() {}, startBoss() {}, stopBoss() {} };

function gameWithConsumables(loadout, hooks = {}) {
  const game = new MattMineGame(null, defaultProfile(), { headless: true, audio: NOOP_AUDIO, ...hooks });
  game.startRun({ mode: 'practice', seed: 'CONSUMABLES', tuning: { _consumables: { loadout } } });
  return game;
}

test('Consumables defaults are 500,000 CRYSTALS and route 100 percent to Treasury', () => {
  const economy = defaultConsumablesEconomy();
  assert.equal(economy.treasuryBps, 10_000);
  assert.equal(economy.maximumPurchaseQuantity, 10);
  assert.equal(economy.maximumLoadoutSize, 3);
  assert.deepEqual(Object.values(economy.items).map((item) => item.priceCrystals), [500_000, 500_000, 500_000]);
  const verifier = new ConsumableCrystalPaymentVerifier({ client: {}, skipInitialization: true });
  assert.equal(verifier.token.toLowerCase(), MATT_CRYSTAL_TOKEN_ADDRESS.toLowerCase());
  assert.equal(verifier.recipient.toLowerCase(), CONSUMABLE_TREASURY_ADDRESS.toLowerCase());
  const transaction = verifier.transactionForPayment(500_000n * 10n ** 18n);
  assert.equal(transaction.to.toLowerCase(), MATT_CRYSTAL_TOKEN_ADDRESS.toLowerCase());
  assert.equal(transaction.value, '0x0');
});

test('loadouts enforce wallet inventory, total size, and per-item Admin limits', () => {
  const wallet = defaultWalletConsumables();
  wallet.inventory = { 'medic-pack': 2, 'mythical-force-field': 1, 'heavy-crystal-hauler': 1 };
  const economy = defaultConsumablesEconomy();
  assert.deepEqual(validateConsumableLoadout({ 'medic-pack': 1, 'mythical-force-field': 1, 'heavy-crystal-hauler': 1 }, economy, wallet), {
    'medic-pack': 1, 'mythical-force-field': 1, 'heavy-crystal-hauler': 1
  });
  assert.throws(() => validateConsumableLoadout({ 'medic-pack': 2 }, economy, wallet), /limited to 1 per run/);
  assert.throws(() => validateConsumableLoadout({ 'medic-pack': 4 }, economy, wallet), /quantity is invalid/);
});

test('Medic Pack requires missing health and Force Field blocks all damage for three seconds', () => {
  const game = gameWithConsumables({ 'medic-pack': 1, 'mythical-force-field': 1, 'heavy-crystal-hauler': 0 });
  assert.equal(game.useConsumable('medic-pack'), false);
  assert.equal(game.run.consumables.remaining['medic-pack'], 1);
  game.player.health = 60;
  assert.equal(game.useConsumable('medic-pack'), true);
  assert.equal(game.player.health, 85);
  assert.equal(game.run.consumables.remaining['medic-pack'], 0);
  assert.equal(game.useConsumable('mythical-force-field'), true);
  game.player.invulnerable = 0;
  game.damagePlayer(50, 0);
  assert.equal(game.player.health, 85);
  game.player.forceFieldRemaining = 0;
  game.damagePlayer(10, 0);
  assert.equal(game.player.health, 75);
});

test('manual Consumable input reaches deterministic mines and records replay-safe commands', () => {
  const events = [];
  const queuedConsumables = ['medic-pack', 'mythical-force-field'];
  const game = gameWithConsumables(
    { 'medic-pack': 1, 'mythical-force-field': 1, 'heavy-crystal-hauler': 0 },
    { onArenaInput: (event) => events.push(event) }
  );
  game.input = {
    pointer: { active: false },
    mobileAttack: false,
    movement: () => ({ x: 0, y: 0 }),
    attacking: () => false,
    consumeDash: () => false,
    consumeWeaponSelection: () => null,
    consumeConsumable: () => queuedConsumables.shift() || null
  };
  game.player.health = 60;

  game.update(0.02);
  assert.equal(game.player.health, 85);
  assert.equal(game.run.consumables.remaining['medic-pack'], 0);

  game.update(0.02);
  assert.ok(game.player.forceFieldRemaining > 2.9);
  assert.equal(game.run.consumables.remaining['mythical-force-field'], 0);
  assert.deepEqual(
    events.filter((event) => event.type === 'command').map((event) => [event.command, event.value]),
    [
      ['consumable', 'medic-pack'],
      ['consumable', 'mythical-force-field']
    ]
  );
});

test('Heavy Crystal Hauler multiplies carried units without multiplying score', () => {
  const game = gameWithConsumables({ 'medic-pack': 0, 'mythical-force-field': 0, 'heavy-crystal-hauler': 1 });
  game.runContext.tuning.nftCrystalCarryLimit = 10;
  game.pickups = [{ type: 'crystal', value: 50, radius: 10, x: game.player.x, y: game.player.y, vx: 0, vy: 0, sourceObjectId: 'crystal-1' }];
  game.updatePickups(0);
  assert.equal(game.run.crystals, 5);
  assert.equal(game.run.crystalsCollected, 5);
  assert.equal(game.run.rawScore, 50);
});

test('server purchase quotes credit wallet inventory once and Admin can add or remove with an audit reason', async () => {
  const now = 1_800_000_000_000;
  const address = '0x1111111111111111111111111111111111111111';
  const token = 'ab'.repeat(32);
  const transactionHash = `0x${'cd'.repeat(32)}`;
  const database = new MemoryDatabase();
  const verifier = {
    ready: true,
    publicStatus: () => ({ configured: true }),
    transactionForPayment: (amountRaw) => ({ to: MATT_CRYSTAL_TOKEN_ADDRESS, value: '0x0', data: `0x${BigInt(amountRaw).toString(16)}` }),
    verifyPayment: async ({ amountRaw }) => ({
      transactionHash,
      token: MATT_CRYSTAL_TOKEN_ADDRESS.toLowerCase(),
      recipient: CONSUMABLE_TREASURY_ADDRESS.toLowerCase(),
      amountRaw,
      blockNumber: '123',
      logIndex: 0
    })
  };
  const service = new MattMineService(database, {
    now: () => now,
    adminKey: 'admin-test-key',
    consumablePaymentVerifier: verifier,
    randomHex: (bytes) => '1'.repeat(bytes * 2)
  });
  await database.transact((state) => {
    state.wallets[address] = defaultWalletState(address, now);
    state.sessions[createHash('sha256').update(token).digest('hex')] = { address, createdAt: now, expiresAt: now + 60_000 };
  });
  const quoted = await service.quoteConsumablePurchase(token, { items: { 'medic-pack': 2 } });
  assert.equal(quoted.quote.totalPriceCrystals, 1_000_000);
  assert.equal(quoted.quote.totalPriceRaw, (1_000_000n * 10n ** 18n).toString());
  const confirmed = await service.confirmConsumablePurchase(token, { quoteId: quoted.quote.id, transactionHash });
  assert.equal(confirmed.catalog.wallet.inventory['medic-pack'], 2);
  const repeated = await service.confirmConsumablePurchase(token, { quoteId: quoted.quote.id, transactionHash });
  assert.equal(repeated.alreadyConfirmed, true);
  assert.equal(repeated.catalog.wallet.inventory['medic-pack'], 2);
  const granted = await service.adminAwardPlayer('admin-test-key', address, { type: 'consumable', consumableId: 'medic-pack', amount: 3 }, 'Event prize grant');
  assert.equal(granted.wallet.consumables.inventory['medic-pack'], 5);
  const removed = await service.adminAwardPlayer('admin-test-key', address, { type: 'consumable', consumableId: 'medic-pack', amount: -2 }, 'Support correction');
  assert.equal(removed.wallet.consumables.inventory['medic-pack'], 3);
});
