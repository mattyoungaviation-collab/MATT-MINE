import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  OperationsMonitor,
  collectInProcessOperationsSignals,
  evaluateOperationsHealth,
  formatOperationsReport,
  operationsAlertFingerprint
} from '../server/operations-monitor.js';
import { MemoryDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);
const ROOT = fileURLToPath(new URL('../', import.meta.url));

function healthySnapshot(overrides = {}) {
  return {
    checkedAt: NOW,
    stage: 'public',
    database: { ok: true, latencyMs: 25 },
    rpc: { ok: true, latencyMs: 180 },
    metadata: {
      ok: true,
      completedAt: new Date(NOW - 60_000).toISOString(),
      tokensValidated: 1_000,
      collectionsValidated: 2,
      imagesValidated: 1_002,
      chainTokensValidated: 1_000,
      chainMetadataValidated: 1_000,
      chainId: 2_020,
      tokenRange: { from: 1, to: 1_000 },
      validationScope: {
        images: true,
        chain: true,
        initialState: true,
        salesWallet: true
      }
    },
    contracts: {
      settlement: { reachable: true, paused: false, expectedPaused: false },
      crystalBank: { reachable: true, paused: false, expectedPaused: false },
      chest: { reachable: true, paused: true, expectedPaused: true },
      passiveRewards: { reachable: true, paused: true, expectedPaused: true }
    },
    roles: {
      operatorAuthorized: true,
      configOperatorAuthorized: true,
      rewardSignerMatches: true,
      operatorSignerSeparated: true,
      keeperAuthorized: true,
      pauserAuthorized: true
    },
    wallets: {
      operatorRon: 0.5,
      keeperRon: 0.5,
      pauserRon: 0.2
    },
    vrf: {
      subscriptionFunded: true,
      chestConsumerRegistered: true,
      passiveConsumerRegistered: true,
      pendingRequests: 0,
      oldestPendingSeconds: 0
    },
    runs: {
      stuck: 0,
      settlementFailuresLastHour: 0,
      rejectedLastHour: 0,
      acceptedLastHour: 20,
      startsLastHour: 20
    },
    economy: {
      banked24hRaw: '100',
      expectedDailyBankCapRaw: '1000',
      withdrawn24hRaw: '50',
      globalWithdrawalLimitRaw: '1000'
    },
    ...overrides
  };
}

test('a complete healthy snapshot produces no alerts', () => {
  const report = evaluateOperationsHealth(healthySnapshot());
  assert.equal(report.status, 'healthy');
  assert.deepEqual(report.counts, { critical: 0, warning: 0, info: 0 });
  assert.deepEqual(report.alerts, []);
  assert.match(formatOperationsReport(report), /MATT Mine operations: HEALTHY/);
});

test('RPC loss, role drift, and contract pause drift are release-critical', () => {
  const snapshot = healthySnapshot({
    rpc: { ok: false, latencyMs: 0 },
    roles: {
      ...healthySnapshot().roles,
      operatorSignerSeparated: false
    },
    contracts: {
      ...healthySnapshot().contracts,
      settlement: { reachable: true, paused: true, expectedPaused: false }
    }
  });
  const report = evaluateOperationsHealth(snapshot);
  assert.equal(report.status, 'critical');
  assert.ok(report.alerts.some((entry) => entry.code === 'rpc_unavailable'));
  assert.ok(report.alerts.some((entry) => entry.code === 'operatorSignerSeparated'));
  assert.ok(report.alerts.some((entry) => entry.code === 'settlement_pause_mismatch'));
});

test('stuck runs and settlement failures stop rollout', () => {
  const report = evaluateOperationsHealth(healthySnapshot({
    runs: {
      stuck: 2,
      settlementFailuresLastHour: 1,
      rejectedLastHour: 4,
      acceptedLastHour: 16,
      startsLastHour: 16
    }
  }));
  assert.equal(report.status, 'critical');
  assert.ok(report.alerts.some((entry) => entry.code === 'stuck_runs_present'));
  assert.ok(report.alerts.some((entry) => entry.code === 'settlement_failures_present'));
  assert.ok(report.alerts.some((entry) => entry.code === 'run_rejection_rate_critical'));
});

test('low balances and delayed VRF requests produce actionable severity', () => {
  const report = evaluateOperationsHealth(healthySnapshot({
    wallets: {
      operatorRon: 0.05,
      keeperRon: 0.01,
      pauserRon: 0.04
    },
    vrf: {
      subscriptionFunded: true,
      chestConsumerRegistered: true,
      passiveConsumerRegistered: true,
      pendingRequests: 2,
      oldestPendingSeconds: 7 * 60 * 60
    }
  }));
  assert.equal(report.status, 'critical');
  assert.ok(report.alerts.some((entry) => entry.code === 'operator_ron_low' && entry.severity === 'warning'));
  assert.ok(report.alerts.some((entry) => entry.code === 'keeper_ron_critical' && entry.severity === 'critical'));
  assert.ok(report.alerts.some((entry) => entry.code === 'vrf_request_stuck'));
});

test('Crystal budget and withdrawal utilization are checked with integer math', () => {
  const warning = evaluateOperationsHealth(healthySnapshot({
    economy: {
      banked24hRaw: '800',
      expectedDailyBankCapRaw: '1000',
      withdrawn24hRaw: '999999999999999999999999999999999999',
      globalWithdrawalLimitRaw: '1000000000000000000000000000000000000'
    }
  }));
  assert.equal(warning.status, 'degraded');
  assert.ok(warning.alerts.some((entry) => entry.code === 'crystal_banking_budget_high'));
  assert.ok(warning.alerts.some((entry) => entry.code === 'withdrawal_limit_high'));

  const critical = evaluateOperationsHealth(healthySnapshot({
    economy: {
      banked24hRaw: '1001',
      expectedDailyBankCapRaw: '1000',
      withdrawn24hRaw: '1001',
      globalWithdrawalLimitRaw: '1000'
    }
  }));
  assert.equal(critical.status, 'critical');
  assert.ok(critical.alerts.some((entry) => entry.code === 'crystal_banking_budget_exceeded'));
  assert.ok(critical.alerts.some((entry) => entry.code === 'withdrawal_limit_exceeded'));
});

test('missing signals fail closed for public release and warn during closed beta', () => {
  const publicReport = evaluateOperationsHealth({ checkedAt: NOW, stage: 'public' });
  assert.equal(publicReport.status, 'critical');
  assert.ok(publicReport.counts.critical >= 8);

  const betaReport = evaluateOperationsHealth({ checkedAt: NOW, stage: 'closed-beta' });
  assert.equal(betaReport.status, 'degraded');
  assert.equal(betaReport.counts.critical, 0);
  assert.ok(betaReport.counts.warning >= 8);
});

test('partially measured authority and VRF signals remain warnings in closed beta', () => {
  const report = evaluateOperationsHealth({
    checkedAt: NOW,
    stage: 'closed-beta',
    roles: { operatorAuthorized: true },
    vrf: { pendingRequests: 0, oldestPendingSeconds: 0 }
  });
  assert.equal(report.counts.critical, 0);
  assert.ok(report.alerts.some((entry) => entry.code === 'configOperatorAuthorized_missing'));
  assert.ok(report.alerts.some((entry) => entry.code === 'subscriptionFunded_missing'));
});

test('unknown release stages are rejected instead of silently becoming closed beta', () => {
  assert.throws(
    () => evaluateOperationsHealth({ checkedAt: NOW, stage: 'publci' }),
    /stage must be closed-beta or public/
  );
});

test('a nominal database signal without latency still fails closed for public release', () => {
  const report = evaluateOperationsHealth(healthySnapshot({
    database: { ok: true }
  }));
  assert.equal(report.status, 'critical');
  assert.ok(report.alerts.some((entry) => entry.code === 'database_latency_missing'));
});

test('public metadata health rejects skipped images and missing chain inventory', () => {
  const report = evaluateOperationsHealth(healthySnapshot({
    metadata: {
      ok: true,
      completedAt: NOW - 60_000,
      tokensValidated: 1_000,
      collectionsValidated: 2,
      imagesValidated: 0,
      chainTokensValidated: 0,
      validationScope: { images: false, chain: false }
    }
  }));
  assert.equal(report.status, 'critical');
  assert.ok(report.alerts.some((entry) => entry.code === 'metadata_images_incomplete'));
  assert.ok(report.alerts.some((entry) => entry.code === 'metadata_chain_inventory_incomplete'));
});

test('run rejection rate uses decided submissions, not run starts', () => {
  const report = evaluateOperationsHealth(healthySnapshot({
    runs: {
      stuck: 0,
      settlementFailuresLastHour: 0,
      rejectedLastHour: 1,
      acceptedLastHour: 0,
      startsLastHour: 1_000
    }
  }));
  assert.ok(report.alerts.some((entry) =>
    entry.code === 'run_rejection_rate_critical' && entry.observed === 10_000
  ));
});

test('alert fingerprints are stable and ignore changing observed values', () => {
  const first = {
    severity: 'warning',
    group: 'balances',
    code: 'operator_ron_low',
    message: 'Operator balance is low.',
    observed: 0.05
  };
  const second = { ...first, observed: 0.04 };
  assert.equal(operationsAlertFingerprint(first), operationsAlertFingerprint(second));
  assert.match(operationsAlertFingerprint(first), /^[a-f0-9]{24}$/);
});

test('operations probes are single-flight, cached, and explicitly refreshable', async () => {
  let calls = 0;
  let release;
  const monitor = new OperationsMonitor({
    stage: 'public',
    cacheMs: 20_000,
    now: () => NOW,
    collect: async () => {
      calls += 1;
      await new Promise((resolve) => { release = resolve; });
      return healthySnapshot();
    }
  });
  const first = monitor.current();
  const second = monitor.current();
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.equal((await first).status, 'healthy');
  assert.equal((await second).status, 'healthy');
  assert.equal((await monitor.current()).status, 'healthy');
  assert.equal(calls, 1);

  const refreshed = monitor.current({ force: true });
  await Promise.resolve();
  assert.equal(calls, 2);
  release();
  await refreshed;
});

test('collector exposes only measured in-process facts and leaves unknown launch evidence missing', async () => {
  const database = {
    healthCheck: async () => ({ ok: true, latencyMs: 12 }),
    read: async () => ({
      wallets: {
        '0x1111111111111111111111111111111111111111': {
          nftCrystalLedger: [{ type: 'RUN_BANK', amount: 25, timestamp: NOW - 1_000 }]
        }
      },
      runs: {
        run_one: {
          status: 'finished',
          startedAt: NOW - 3_000,
          finishedAt: NOW - 2_000,
          result: { extracted: true },
          nftSettlement: { minerId: 1 }
        }
      }
    })
  };
  const signals = await collectInProcessOperationsSignals({
    checkedAt: NOW,
    database,
    getNftHealth: async () => ({
      enabled: true,
      metadata: { enabled: true, ok: true, latencyMs: 50 },
      gameplay: {
        enabled: true,
        ok: true,
        latencyMs: 80,
        operator: {
          address: '0x1111111111111111111111111111111111111111',
          authorized: true
        },
        rewardSigner: {
          configuredAddress: '0x2222222222222222222222222222222222222222',
          matches: true
        },
        nativeBalancesRaw: { operator: '500000000000000000' }
      }
    }),
    getProtocolSnapshot: async () => ({
      paused: { settlement: false, bank: false, chest: true },
      withdrawal: { globalDailyRaw: '1000000000000000000000' }
    })
  });
  assert.deepEqual(signals.database, { ok: true, latencyMs: 12 });
  assert.deepEqual(signals.rpc, { ok: true, latencyMs: 80 });
  assert.equal(signals.roles.operatorAuthorized, true);
  assert.equal(signals.roles.operatorSignerSeparated, true);
  assert.equal(signals.wallets.operatorRon, 0.5);
  assert.equal(signals.runs.settlementFailuresLastHour, 1);
  assert.equal(signals.runs.rejectedLastHour, undefined);
  assert.equal(signals.economy.banked24hRaw, '25000000000000000000');
  assert.equal(signals.economy.withdrawn24hRaw, undefined);

  const report = evaluateOperationsHealth({ ...signals, stage: 'public', checkedAt: NOW });
  assert.equal(report.status, 'critical');
  assert.ok(report.alerts.some((entry) => entry.code === 'settlement_failures_present'));
  assert.ok(report.alerts.some((entry) => entry.code === 'run_metric_invalid'));
  assert.ok(report.alerts.some((entry) => entry.code === 'metadata_signal_missing'));
});

test('collector failure remains a critical public report and documents external automation', async () => {
  const monitor = new OperationsMonitor({
    stage: 'public',
    now: () => NOW,
    collect: async () => { throw new Error('private probe detail'); }
  });
  const report = await monitor.current();
  assert.equal(report.status, 'critical');
  assert.equal(report.collectionFailed, true);
  assert.equal(report.signals.database, 'missing');
  assert.deepEqual(
    [report.externalAutomation.scheduler, report.externalAutomation.alertDelivery, report.externalAutomation.onCallRouting],
    [false, false, false]
  );
  assert.doesNotMatch(JSON.stringify(report), /private probe detail/);
});

test('current operations report is admin-authenticated and refresh reaches the monitor', async (context) => {
  let calls = 0;
  const monitor = new OperationsMonitor({
    stage: 'public',
    cacheMs: 20_000,
    now: () => NOW,
    collect: async () => {
      calls += 1;
      return healthySnapshot();
    }
  });
  const service = new CompleteProductionMattMineService(new MemoryDatabase(), {
    adminKey: 'operations-secret',
    operationsMonitor: monitor
  });
  const server = createMattMineHttpServer({ root: ROOT, service });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${base}/api/admin/operations-health`)).status, 401);
  const first = await fetch(`${base}/api/admin/operations-health`, {
    headers: { 'x-matt-admin-key': 'operations-secret' }
  });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).report.status, 'healthy');
  assert.equal(calls, 1);
  const overview = await fetch(`${base}/api/admin/overview`, {
    headers: { 'x-matt-admin-key': 'operations-secret' }
  });
  assert.equal(overview.status, 200);
  assert.equal((await overview.json()).operationsHealth.status, 'healthy');
  assert.equal(calls, 1);
  const forced = await fetch(`${base}/api/admin/operations-health?refresh=true`, {
    headers: { 'x-matt-admin-key': 'operations-secret' }
  });
  assert.equal(forced.status, 200);
  assert.equal(calls, 2);
});

test('Admin dashboard renders the authenticated report and names external setup honestly', async () => {
  const [html, script] = await Promise.all([
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/admin.js', import.meta.url), 'utf8')
  ]);
  assert.match(html, /id="operations-health"/);
  assert.match(html, /Scheduling, alert delivery, and on-call routing require external setup/);
  assert.match(script, /api\/admin\/operations-health\?refresh=true/);
  assert.match(script, /renderOperationsHealth/);
});
