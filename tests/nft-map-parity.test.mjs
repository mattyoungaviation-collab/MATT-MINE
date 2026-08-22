import test from 'node:test';
import assert from 'node:assert/strict';

import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryDatabase } from '../server/database.js';
import { RONIN_CHAINS } from '../server/constants.js';

function harness() {
  let activeMap = null;
  const database = new MemoryDatabase();
  const nftGameplayService = {
    async activeMap(mode) {
      return { mode, approved: true, retired: false, ...activeMap };
    }
  };
  const nftV2AdminService = {
    publicStatus: () => ({ enabled: true }),
    snapshot: async () => ({ activeMaps: {} })
  };
  const service = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftGameplayService,
    nftV2AdminService
  });
  return {
    service,
    setActiveMap(value) { activeMap = value; }
  };
}

test('NFT reward runs accept the exact Studio map committed on-chain', async () => {
  const { service, setActiveMap } = harness();
  const protocol = await service.adminNftV2Protocol('admin-secret');
  const expected = protocol.mapDefaults.paid;
  setActiveMap({
    versionId: `0x${'11'.repeat(32)}`,
    mapId: expected.mapId,
    contentHash: expected.contentHash
  });

  const parity = await service.assertNftMapMatchesStudio('paid');
  assert.equal(parity.studioMap.mapId, expected.mapId);
  assert.equal(parity.activeMap.contentHash, expected.contentHash);
});

test('NFT reward runs fail closed when Studio and the active contract map drift', async () => {
  const { service, setActiveMap } = harness();
  setActiveMap({
    versionId: `0x${'22'.repeat(32)}`,
    mapId: `0x${'33'.repeat(32)}`,
    contentHash: `0x${'44'.repeat(32)}`
  });

  await assert.rejects(
    () => service.assertNftMapMatchesStudio('paid'),
    (error) => error.code === 'nft_map_content_drift'
  );
});

test('a Studio publication change invalidates an in-flight map review', async () => {
  const { service, setActiveMap } = harness();
  const protocol = await service.adminNftV2Protocol('admin-secret');
  const expected = protocol.mapDefaults.arena;
  setActiveMap({ mapId: expected.mapId, contentHash: expected.contentHash });

  await assert.rejects(
    () => service.assertNftMapMatchesStudio('arena', `0x${'55'.repeat(32)}`),
    (error) => error.code === 'competition_snapshot_changed'
  );
});

test('operational readiness coalesces and caches chain health fanout', async () => {
  const database = new MemoryDatabase();
  let healthCalls = 0;
  let activeMaps = {};
  const gameplay = {
    async health() {
      healthCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { enabled: true, ok: true, activeMaps };
    }
  };
  const service = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftGameplayService: gameplay
  });
  const protocolService = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftGameplayService: { async activeMap() {} },
    nftV2AdminService: { publicStatus: () => ({}), snapshot: async () => ({}) }
  });
  const defaults = (await protocolService.adminNftV2Protocol('admin-secret')).mapDefaults;
  activeMaps = Object.fromEntries(['arena', 'paid'].map((mode) => [mode, {
    approved: true,
    retired: false,
    versionId: `0x${(mode === 'arena' ? '11' : '22').repeat(32)}`,
    mapId: defaults[mode].mapId,
    contentHash: defaults[mode].contentHash
  }]));
  const snapshots = await Promise.all([
    service.nftOperationalHealth(),
    service.nftOperationalHealth(),
    service.nftOperationalHealth()
  ]);
  assert.equal(healthCalls, 1);
  assert.equal(snapshots.every((snapshot) => snapshot.ok), true);
  assert.equal((await service.nftOperationalHealth()).ok, true);
  assert.equal(healthCalls, 1);
});

test('operational readiness fails when an active chain route drifts from Studio', async () => {
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftHealthCacheMs: 0,
    nftGameplayService: {
      async health() {
        return {
          enabled: true,
          ok: true,
          activeMaps: Object.fromEntries(['arena', 'paid'].map((mode) => [mode, {
            approved: true,
            retired: false,
            versionId: `0x${'33'.repeat(32)}`,
            mapId: `0x${'44'.repeat(32)}`,
            contentHash: `0x${'55'.repeat(32)}`
          }]))
        };
      }
    }
  });

  const health = await service.nftOperationalHealth();
  assert.equal(health.ok, false);
  assert.equal(health.gameplay.ok, false);
  assert.equal(health.gameplay.studioParity.ok, false);
  assert.equal(health.gameplay.studioParity.routes.arena.ok, false);
  assert.equal(health.gameplay.studioParity.routes.paid.ok, false);
});

test('phase XP cannot change while a Pass Mine run is active or awaiting revive', async () => {
  const database = new MemoryDatabase();
  let writes = 0;
  const service = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftV2AdminService: {
      async setPhaseXp() {
        writes += 1;
        return {
          mode: 'paid',
          versionId: `0x${'11'.repeat(32)}`,
          phaseXp: [10, 20, 30, 40, 50],
          transactionHash: `0x${'22'.repeat(32)}`
        };
      }
    }
  });
  await database.transact((state) => {
    state.runs.activePaid = {
      id: 'activePaid',
      address: `0x${'12'.repeat(20)}`,
      mode: 'paid',
      status: 'active',
      startedAt: Date.UTC(2026, 7, 22, 0, 0, 0),
      expiresAt: Date.UTC(2026, 7, 22, 1, 0, 0)
    };
  });

  await assert.rejects(
    () => service.updateAdminNftV2PhaseXp('admin-secret', {
      mode: 'paid',
      phaseXp: [10, 20, 30, 40, 50],
      reason: 'Launch economy update'
    }),
    (error) => error.code === 'nft_phase_xp_active_runs'
  );
  await database.transact((state) => {
    state.runs.activePaid.status = 'awaiting-revive';
    state.runs.activePaid.pendingRevive = {
      id: 'phase-xp-pending-revive',
      status: 'pending'
    };
  });
  await assert.rejects(
    () => service.updateAdminNftV2PhaseXp('admin-secret', {
      mode: 'paid',
      phaseXp: [10, 20, 30, 40, 50],
      reason: 'Launch economy update'
    }),
    (error) => error.code === 'nft_phase_xp_active_runs'
  );
  assert.equal(writes, 0);
});

test('phase XP fails closed when Arena activity cannot be verified', async () => {
  const database = new MemoryDatabase();
  let writes = 0;
  const service = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    arenaService: {
      async adminActiveRuns() {
        throw new Error('database unavailable');
      }
    },
    nftV2AdminService: {
      async setPhaseXp() {
        writes += 1;
      }
    }
  });

  await assert.rejects(
    () => service.updateAdminNftV2PhaseXp('admin-secret', {
      mode: 'arena',
      phaseXp: [10, 20, 30, 40, 50],
      reason: 'Launch economy update'
    }),
    (error) => error.code === 'nft_phase_xp_active_run_check_failed'
  );
  assert.equal(writes, 0);
});

test('phase XP updates and NFT starts share one serialization barrier', async () => {
  const database = new MemoryDatabase();
  const order = [];
  let releaseUpdate;
  const updateHeld = new Promise((resolve) => { releaseUpdate = resolve; });
  const service = new CompleteProductionMattMineService(database, {
    now: () => Date.UTC(2026, 7, 22, 0, 0, 0),
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret',
    chainId: RONIN_CHAINS.MAINNET,
    nftV2AdminService: {
      async setPhaseXp() {
        order.push('update-started');
        await updateHeld;
        order.push('update-finished');
        return {
          mode: 'paid',
          versionId: `0x${'33'.repeat(32)}`,
          phaseXp: [10, 20, 30, 40, 50],
          transactionHash: `0x${'44'.repeat(32)}`
        };
      }
    }
  });

  const update = service.updateAdminNftV2PhaseXp('admin-secret', {
    mode: 'paid',
    phaseXp: [10, 20, 30, 40, 50],
    reason: 'Launch economy update'
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startCriticalSection = service.withNftLifecycleStart(() => {
    order.push('run-started');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['update-started']);
  releaseUpdate();
  await Promise.all([update, startCriticalSection]);
  assert.deepEqual(order, ['update-started', 'update-finished', 'run-started']);
});
