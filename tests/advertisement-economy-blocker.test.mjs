import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryNuggetEconomyStore } from '../server/nugget-economy.js';

const START = Date.UTC(2026, 6, 28, 12, 0, 0);

test('advertisement rewards remain blocked until provider completion verification exists', async () => {
  const economyStore = new MemoryNuggetEconomyStore();
  const service = new CompleteProductionMattMineService(new MemoryDatabase(), {
    now: () => START,
    adminKey: 'test-admin-key',
    nuggetEconomyStore: economyStore,
    nuggetPaymentsEnabled: false
  });

  await assert.rejects(
    service.updateAdminNuggetEconomy(
      'wrong-admin-key',
      { advertisementRewardsEnabled: true },
      'Attempt to enable advertisements without authorization.'
    ),
    (error) => error.code === 'admin_key_rejected'
  );

  await assert.rejects(
    service.updateAdminNuggetEconomy(
      'test-admin-key',
      { advertisementRewardsEnabled: true },
      'Attempt to enable advertisements without provider verification.'
    ),
    (error) => error.code === 'advertisement_provider_disabled'
  );

  const state = await economyStore.read();
  assert.equal(state.config.advertisementRewardsEnabled, false);

  const disabled = await service.updateAdminNuggetEconomy(
    'test-admin-key',
    { advertisementRewardsEnabled: false },
    'Keep advertisement rewards disabled for production safety.'
  );
  assert.equal(disabled.config.advertisementRewardsEnabled, false);
});
