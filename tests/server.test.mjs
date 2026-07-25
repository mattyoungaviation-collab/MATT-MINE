import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';

import { MattMineApiClient, SESSION_STORAGE_KEY } from '../src/game/apiClient.js';
import { RoninWalletAdapter, parseChainId } from '../src/game/walletAdapter.js';
import { MemoryDatabase, JsonFileDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { MattMineService } from '../server/service.js';
import { AUTH_CHALLENGE_TTL_MS, RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_PRIVATE_KEY = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const account = privateKeyToAccount(PRIVATE_KEY);
const otherAccount = privateKeyToAccount(OTHER_PRIVATE_KEY);
const START = Date.UTC(2026, 6, 25, 12, 0, 0);
const ORIGIN = 'http://localhost:4173';
const UNSUPPORTED_CHAIN_ID = 1;

function createHarness(options = {}) {
  let timestamp = options.timestamp ?? START;
  let randomCounter = 0;
  const database = options.database || new MemoryDatabase();
  const service = new MattMineService(database, {
    now: () => timestamp,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: options.adminKey || 'test-admin-key',
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return {
    database,
    service,
    now: () => timestamp,
    advance(milliseconds) {
      timestamp += milliseconds;
      return timestamp;
    }
  };
}

async function signIn(harness, signer = account) {
  const challenge = await harness.service.createChallenge({
    address: signer.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await signer.signMessage({ message: challenge.message });
  const session = await harness.service.verifyChallenge({
    address: signer.address,
    nonce: challenge.nonce,
    signature
  });
  return { challenge, signature, session };
}

function extractedResult(overrides = {}) {
  return {
    extracted: true,
    projected: 1_000,
    banked: 1_000,
    depth: 1,
    kills: 8,
    oreBroken: 5,
    elapsed: 60,
    ...overrides
  };
}

async function finish(service, session, run, result) {
  return service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result
  });
}

test('Ronin SIWE-style challenges bind origin, chain, address, expiry, and one-time use', async () => {
  assert.throws(
    () => new MattMineService(new MemoryDatabase(), { chainId: UNSUPPORTED_CHAIN_ID }),
    (error) => error.code === 'invalid_server_chain'
  );
  const harness = createHarness();
  const { challenge, signature, session } = await signIn(harness);
  assert.match(challenge.message, /wants you to sign in with your Ronin account/);
  assert.match(challenge.message, new RegExp(`Chain ID: ${RONIN_CHAINS.MAINNET}`));
  assert.match(challenge.message, /does not initiate a transaction or spend RON or MATT/);
  assert.equal(session.address, account.address.toLowerCase());
  assert.equal(session.entitlements.freeRunAvailable, true);
  assert.equal(session.token.length, 64);

  await assert.rejects(
    () => harness.service.verifyChallenge({
      address: account.address,
      nonce: challenge.nonce,
      signature
    }),
    (error) => error.code === 'challenge_not_found'
  );

  await assert.rejects(
    () => harness.service.createChallenge({
      address: account.address,
      chainId: UNSUPPORTED_CHAIN_ID,
      origin: ORIGIN
    }),
    (error) => error.code === 'wrong_chain'
  );
  await assert.rejects(
    () => harness.service.createChallenge({
      address: account.address,
      chainId: RONIN_CHAINS.MAINNET,
      origin: 'https://evil.example'
    }),
    (error) => error.code === 'origin_mismatch'
  );
});

test('wrong-wallet and expired signatures cannot create sessions', async () => {
  const harness = createHarness();
  const challenge = await harness.service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const wrongSignature = await otherAccount.signMessage({ message: challenge.message });
  await assert.rejects(
    () => harness.service.verifyChallenge({
      address: account.address,
      nonce: challenge.nonce,
      signature: wrongSignature
    }),
    (error) => error.code === 'signature_rejected'
  );

  const expiring = await harness.service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: expiring.message });
  harness.advance(AUTH_CHALLENGE_TTL_MS + 1);
  await assert.rejects(
    () => harness.service.verifyChallenge({
      address: account.address,
      nonce: expiring.nonce,
      signature
    }),
    (error) => error.code === 'challenge_expired'
  );
});

test('the server owns the free entitlement, run token, replay protection, profile, and leaderboard score', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  assert.equal(run.seed, 'MATT-MINE-2026-07-25-FREE');
  harness.advance(60_000);
  const accepted = await finish(harness.service, session, run, extractedResult());
  assert.equal(accepted.run.result.score, 1_000);
  assert.equal(accepted.profile.bankedNuggets, 1_000);
  assert.equal(accepted.profile.totalRuns, 1);
  assert.equal(accepted.leaderboard.playerRank, 1);
  assert.equal(accepted.leaderboard.playerScore, 1_000);

  await assert.rejects(
    () => finish(harness.service, session, run, extractedResult()),
    (error) => error.code === 'run_already_finished'
  );
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'free_run_used'
  );

  const player = await harness.service.me(session.token);
  assert.equal(player.entitlements.freeRunAvailable, false);
  assert.equal(player.scores.free, 1_000);
});

test('paid server runs stay disabled while authenticated Practice remains unlimited', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.PAID),
    (error) => error.code === 'paid_runs_disabled'
  );
  const first = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  const second = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.notEqual(first.runId, second.runId);
});

test('impossible telemetry is rejected without consuming the active run submission', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(1_000);
  await assert.rejects(
    () => finish(harness.service, session, run, extractedResult({ elapsed: 100 })),
    (error) => error.code === 'elapsed_time_impossible'
  );
  harness.advance(59_000);
  const accepted = await finish(harness.service, session, run, extractedResult());
  assert.equal(accepted.accepted, true);
});

test('ranked knockouts score only the exact secured 35 percent loot amount', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  harness.advance(30_000);
  await assert.rejects(
    () => finish(harness.service, session, run, extractedResult({
      extracted: false,
      projected: 1_001,
      banked: 351,
      elapsed: 30
    })),
    (error) => error.code === 'knockout_mismatch'
  );
  const accepted = await finish(harness.service, session, run, extractedResult({
    extracted: false,
    projected: 1_001,
    banked: 350,
    elapsed: 30
  }));
  assert.equal(accepted.run.result.score, 350);
  assert.equal(accepted.profile.bankedNuggets, 350);
});

test('server suspension blocks ranked issuance and submission but keeps Practice available', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const ranked = await harness.service.startRun(session.token, SERVER_RUN_MODES.FREE);
  await harness.service.setWalletSuspension('test-admin-key', account.address, true);
  harness.advance(60_000);
  await assert.rejects(
    () => finish(harness.service, session, ranked, extractedResult()),
    (error) => error.code === 'wallet_suspended'
  );
  await assert.rejects(
    () => harness.service.startRun(session.token, SERVER_RUN_MODES.FREE),
    (error) => error.code === 'wallet_suspended'
  );
  const practice = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  assert.equal(practice.mode, SERVER_RUN_MODES.PRACTICE);
  await assert.rejects(
    () => harness.service.setWalletSuspension('wrong-key', account.address, false),
    (error) => error.code === 'admin_key_rejected'
  );
});

test('permanent upgrades spend only server-owned banked nuggets', async () => {
  const harness = createHarness();
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  harness.advance(60_000);
  await finish(harness.service, session, run, extractedResult());
  const upgraded = await harness.service.purchaseUpgrade(session.token, 'health');
  assert.equal(upgraded.cost, 75);
  assert.equal(upgraded.rank, 1);
  assert.equal(upgraded.profile.bankedNuggets, 925);
  assert.equal(upgraded.profile.meta.health, 1);
});

test('JSON server storage persists profiles and recovers corrupt state safely', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'matt-mine-v6-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'store.json');
  const database = await new JsonFileDatabase(filePath, { now: () => START }).init();
  const harness = createHarness({ database });
  const { session } = await signIn(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  harness.advance(60_000);
  await finish(harness.service, session, run, extractedResult());

  const reloaded = await new JsonFileDatabase(filePath).init();
  const persisted = await reloaded.read();
  assert.equal(persisted.wallets[account.address.toLowerCase()].profile.bankedNuggets, 1_000);

  await writeFile(filePath, '{broken-json', 'utf8');
  const recovered = await new JsonFileDatabase(filePath, { now: () => START + 1 }).init();
  assert.ok(recovered.recoveredFile?.endsWith(`.corrupt-${START + 1}`));
  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')).wallets, {});
});

test('the HTTP server exposes same-origin APIs, security headers, and authenticated player data', async (context) => {
  const harness = createHarness();
  const server = createMattMineHttpServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    service: harness.service
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const configResponse = await fetch(`${baseUrl}/api/config`);
  assert.equal(configResponse.status, 200);
  assert.equal(configResponse.headers.get('x-frame-options'), 'DENY');
  const configPayload = await configResponse.json();
  assert.equal(configPayload.config.chainId, RONIN_CHAINS.MAINNET);
  assert.equal(configPayload.config.chainName, 'Ronin Mainnet');
  assert.equal(configPayload.config.paidRunsEnabled, false);
  assert.equal(configPayload.config.realPaymentsEnabled, false);
  assert.equal(configPayload.config.mattClaimsEnabled, false);
  assert.equal(configPayload.config.mainnetTransactionsEnabled, false);

  const crossOrigin = await fetch(`${baseUrl}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
    body: JSON.stringify({
      address: account.address,
      chainId: RONIN_CHAINS.MAINNET,
      origin: 'https://evil.example'
    })
  });
  assert.equal(crossOrigin.status, 403);
});

test('the browser API client stores sessions only in session storage and clears them on 401', async () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) || null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key)
  };
  const client = new MattMineApiClient({
    storage,
    fetch: async () => new Response(JSON.stringify({
      ok: false,
      error: { code: 'session_expired', message: 'Expired' }
    }), {
      status: 401,
      headers: { 'content-type': 'application/json' }
    })
  });
  client.setToken('a'.repeat(64));
  assert.equal(values.get(SESSION_STORAGE_KEY), 'a'.repeat(64));
  await assert.rejects(() => client.me(), (error) => error.code === 'session_expired');
  assert.equal(values.has(SESSION_STORAGE_KEY), false);
});

test('the Ronin adapter switches to Mainnet, signs the server message, and invalidates on account change', async () => {
  const calls = [];
  const listeners = new Map();
  const provider = {
    async request(payload) {
      calls.push(payload);
      if (payload.method === 'eth_requestAccounts') return [account.address];
      if (payload.method === 'eth_chainId') {
        const switched = calls.some((entry) => entry.method === 'wallet_switchEthereumChain');
        return switched ? `0x${RONIN_CHAINS.MAINNET.toString(16)}` : `0x${UNSUPPORTED_CHAIN_ID.toString(16)}`;
      }
      if (payload.method === 'wallet_switchEthereumChain') return null;
      if (payload.method === 'personal_sign') return `0x${'1'.repeat(130)}`;
      throw new Error(`Unexpected method ${payload.method}`);
    },
    on(event, listener) {
      listeners.set(event, listener);
    },
    removeListener(event) {
      listeners.delete(event);
    }
  };
  let cleared = false;
  let invalidated = '';
  const api = {
    hasSession: () => false,
    config: async () => ({ chainId: RONIN_CHAINS.MAINNET, chainName: 'Ronin Mainnet' }),
    createChallenge: async () => ({ nonce: 'a'.repeat(24), message: 'Sign in safely' }),
    verifyChallenge: async () => ({ address: account.address.toLowerCase(), profile: {}, entitlements: {} }),
    clearSession() {
      cleared = true;
    }
  };
  const adapter = new RoninWalletAdapter({
    api,
    window: { ronin: { provider }, location: { origin: ORIGIN } },
    onInvalidated(reason) {
      invalidated = reason;
    }
  });
  const player = await adapter.connect();
  assert.equal(player.address, account.address.toLowerCase());
  assert.equal(calls.some((entry) => entry.method === 'wallet_switchEthereumChain'), true);
  assert.equal(calls.some((entry) => entry.method === 'personal_sign'), true);
  listeners.get('accountsChanged')?.([otherAccount.address]);
  assert.equal(cleared, true);
  assert.match(invalidated, /account changed/i);
  assert.equal(parseChainId('0x7e4'), RONIN_CHAINS.MAINNET);
});
