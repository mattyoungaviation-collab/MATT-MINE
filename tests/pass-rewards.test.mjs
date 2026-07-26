import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PASS_CHEST_ID,
  PASS_COSMETICS,
  PASS_REWARD_LEVELS,
  canEquipCosmetic,
  defaultPassInventory
} from '../src/game/passRewards.js';
import { defaultServerState, normalizeServerState } from '../server/state.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

test('the Pass catalog defines eight permanent levels and valid cosmetic slots', () => {
  assert.equal(PASS_REWARD_LEVELS.length, 8);
  assert.deepEqual(PASS_REWARD_LEVELS.map((reward) => reward.level), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(PASS_REWARD_LEVELS[2].chestId, PASS_CHEST_ID);
  assert.equal(Object.keys(PASS_COSMETICS).length, 8);
  assert.equal(PASS_COSMETICS.starter_badge.image, '/assets/matt-coin-official.png');
  const inventory = defaultPassInventory();
  inventory.cosmetics.push('gold_trail');
  assert.equal(canEquipCosmetic(inventory, 'trail', 'gold_trail'), true);
  assert.equal(canEquipCosmetic(inventory, 'skin', 'gold_trail'), false);
  assert.equal(canEquipCosmetic(inventory, 'trail', 'crystal_skin'), false);
});

test('server state migration sanitizes corrupt cosmetics without losing valid permanent unlocks', () => {
  const source = defaultServerState();
  source.wallets[ADDRESS] = {
    address: ADDRESS,
    profile: {},
    passProgress: { xp: 3_800, updatedAt: 123 },
    passInventory: {
      claimedLevels: [8, 3, 3, -1, 99, '4'],
      cosmetics: ['gold_trail', 'crystal_skin', 'not_real', 'gold_trail'],
      equipped: {
        trail: 'gold_trail',
        skin: 'gold_trail',
        title: 'ore_reactor_title',
        unknown: 'crystal_skin'
      },
      chests: {
        [PASS_CHEST_ID]: {
          available: 1,
          opened: -7,
          lastOpenedAt: 456
        }
      }
    },
    daily: {},
    createdAt: 1,
    updatedAt: 2
  };
  const normalized = normalizeServerState(source);
  const inventory = normalized.wallets[ADDRESS].passInventory;
  assert.deepEqual(inventory.claimedLevels, [3, 8]);
  assert.deepEqual(inventory.cosmetics, ['gold_trail', 'crystal_skin']);
  assert.equal(inventory.equipped.trail, 'gold_trail');
  assert.equal(inventory.equipped.skin, '');
  assert.equal(inventory.equipped.title, '');
  assert.equal(inventory.chests[PASS_CHEST_ID].available, 1);
  assert.equal(inventory.chests[PASS_CHEST_ID].opened, 0);
});
