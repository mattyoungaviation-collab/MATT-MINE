import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { ProductionMattMineService } from '../server/production-service.js';
import {
  MemoryNuggetEconomyStore,
  defaultNuggetEconomyConfig
} from '../server/nugget-economy.js';
import { DirectRoninNuggetPaymentVerifier } from '../server/nugget-payment-verifier.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const SECOND_PRIVATE_KEY = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const account = privateKeyToAccount(PRIVATE_KEY);
const secondAccount = privateKeyToAccount(SECOND_PRIVATE_KEY);
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 6, 28, 12, 0, 0);
const TX_A = `0x${'a'.repeat(64)}`;
const TX_B = `0x${'b'.repeat(64)}`;
const TX_C = `0x${'c'.repeat(64)}`;

class FakeExactVerifier {
  constructor() {
    this.calls = [];
  }

  transactionForQuote(quote) {
    return {
      to: quote.asset === 'MATT' ? quote.mattTokenAddress : quote.recipient,
      value: quote.asset === 'RON' ? `0x${BigInt(quote.amountAtomic).toString(16)}` : '0x0',
      data: quote.asset === 'MATT' ? '0xa9059cbb' : '0x'
    };
  }

  async verifyExactTransfer(transactionHash, expectedAddress, quote) {
    this.calls.push({ transactionHash, expectedAddress, quote: structuredClone(quote) });
    return {
      transactionHash,
      blockNumber: '12345',
      asset: quote.asset,
      amountAtomic: quote.amountAtomic,
      recipient: quote.recipient
    };
  }
}

function createHarness(options = {}) {
  let timestamp = options.timestamp ?? START;
  let randomCounter = 0;
  const database = options.database || new MemoryDatabase();
  const economyStore = options.economyStore || new MemoryNuggetEconomyStore();
  const verifier = options.verifier || new FakeExactVerifier();
  const service = new ProductionMattMineService(database, {
    now: () => timestamp,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    mainnetTransactionsEnabled: true,
    paymentVerifier: {},
    nuggetEconomyStore: economyStore,
    nuggetPaymentVerifier: verifier,
    nuggetPaymentsEnabled: true,
    randomHex(bytes) {
      randomCounter += 1;
      return randomCounter.toString(16).padStart(bytes * 2, '0').slice(-bytes * 2);
    }
  });
  return {
    database,
    economyStore,
    verifier,
    service,
    now: () => timestamp,
    setTime(value) {
      timestamp = value;
    },
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
  return harness.service.verifyChallenge({
    address: signer.address,
    nonce: challenge.nonce,
    signature
  });
}

async function enableEconomy(harness, overrides = {}) {
  const defaults = defaultNuggetEconomyConfig();
  return harness.service.updateAdminNuggetEconomy('test-admin-key', {
    purchasesEnabled: true,
    practiceClaimsEnabled: true,
    dailyPurchaseCap: overrides.dailyPurchaseCap ?? 1_000_000,
    quoteTtlMs: overrides.quoteTtlMs ?? 5 * 60_000,
    allowedAssets: { MATT: true, RON: false },
    packages: overrides.packages || defaults.packages,
    practiceClaim: defaults.practiceClaim
  }, 'Enable exact economy for automated verification tests.');
}

test('nugget economy stays disabled until both Admin and release verifier enable it', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  await assert.rejects(
    harness.service.quoteNuggetPurchase(session.token, { packageId: 'nuggets-1m', asset: 'MATT' }),
    (error) => error.code === 'nugget_purchases_disabled'
  );

  const disabledService = new ProductionMattMineService(harness.database, {
    now: harness.now,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'test-admin-key',
    mainnetTransactionsEnabled: true,
    paymentVerifier: {},
    nuggetEconomyStore: harness.economyStore,
    nuggetPaymentVerifier: harness.verifier,
    nuggetPaymentsEnabled: false
  });
  await assert.rejects(
    disabledService.updateAdminNuggetEconomy('test-admin-key', { purchasesEnabled: true }, 'Attempt unsafe live enable.'),
    (error) => error.code === 'nugget_payment_verifier_disabled'
  );
});

test('verified package purchase credits the server ledger once and appears in history', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  await enableEconomy(harness);
  const quoted = await harness.service.quoteNuggetPurchase(session.token, {
    packageId: 'nuggets-1m',
    asset: 'MATT'
  });
  assert.equal(quoted.quote.nuggets, 1_000_000);
  assert.equal(quoted.quote.amountAtomic, '5000000000000000000000');
  assert.equal(quoted.quote.transaction.to.toLowerCase(), '0xa5450417bdca0bdfb058ffe41205400ffda1174d');

  const confirmed = await harness.service.confirmNuggetPurchase(session.token, {
    quoteId: quoted.quote.id,
    transactionHash: TX_A
  });
  assert.equal(confirmed.profile.bankedNuggets, 1_000_000);
  assert.equal(confirmed.ledgerEntry.type, 'NUGGET_PURCHASE');
  assert.equal(confirmed.ledgerEntry.transactionHash, TX_A);

  const repeated = await harness.service.confirmNuggetPurchase(session.token, {
    quoteId: quoted.quote.id,
    transactionHash: TX_A
  });
  assert.equal(repeated.alreadyConfirmed, true);

  const persisted = await harness.database.read();
  const wallet = persisted.wallets[account.address.toLowerCase()];
  assert.equal(wallet.profile.bankedNuggets, 1_000_000);
  assert.equal(wallet.nuggetLedger.filter((entry) => entry.type === 'NUGGET_PURCHASE').length, 1);
  const me = await harness.service.me(session.token);
  assert.equal(me.nuggetEconomy.purchasedToday, 1_000_000);
  assert.equal(me.nuggetEconomy.purchaseHistory.length, 1);
});

test('daily cap is enforced at quote and confirmation boundaries and resets at UTC midnight', async () => {
  const packages = [{
    id: 'six-hundred-k',
    name: '600,000 Nuggets',
    nuggets: 600_000,
    displayedUsd: 3,
    enabled: true,
    prices: { MATT: '3000000000000000000000', RON: '0' }
  }];
  const harness = createHarness({ timestamp: Date.UTC(2026, 6, 28, 23, 58, 0) });
  const session = await signIn(harness);
  await enableEconomy(harness, { packages, dailyPurchaseCap: 1_000_000 });
  const first = await harness.service.quoteNuggetPurchase(session.token, { packageId: 'six-hundred-k' });
  await harness.service.confirmNuggetPurchase(session.token, { quoteId: first.quote.id, transactionHash: TX_A });

  await assert.rejects(
    harness.service.quoteNuggetPurchase(session.token, { packageId: 'six-hundred-k' }),
    (error) => error.code === 'nugget_daily_cap'
  );

  harness.setTime(Date.UTC(2026, 6, 29, 0, 0, 1));
  const nextDay = await harness.service.quoteNuggetPurchase(session.token, { packageId: 'six-hundred-k' });
  assert.equal(nextDay.quote.nuggets, 600_000);
});

test('a transaction hash cannot be reused for another quote or another wallet', async () => {
  const packages = [{
    id: 'half-million',
    name: '500,000 Nuggets',
    nuggets: 500_000,
    displayedUsd: 2.5,
    enabled: true,
    prices: { MATT: '2500000000000000000000', RON: '0' }
  }];
  const harness = createHarness();
  const firstSession = await signIn(harness, account);
  const secondSession = await signIn(harness, secondAccount);
  await enableEconomy(harness, { packages, dailyPurchaseCap: 1_000_000 });
  const first = await harness.service.quoteNuggetPurchase(firstSession.token, { packageId: 'half-million' });
  const second = await harness.service.quoteNuggetPurchase(secondSession.token, { packageId: 'half-million' });
  await harness.service.confirmNuggetPurchase(firstSession.token, { quoteId: first.quote.id, transactionHash: TX_A });
  await assert.rejects(
    harness.service.confirmNuggetPurchase(secondSession.token, { quoteId: second.quote.id, transactionHash: TX_A }),
    (error) => error.code === 'transaction_duplicate'
  );
});

test('expired quotes are rejected without crediting nuggets', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  await enableEconomy(harness, { quoteTtlMs: 30_000 });
  const quoted = await harness.service.quoteNuggetPurchase(session.token, { packageId: 'nuggets-1m' });
  harness.advance(30_001);
  await assert.rejects(
    harness.service.confirmNuggetPurchase(session.token, { quoteId: quoted.quote.id, transactionHash: TX_A }),
    (error) => error.code === 'quote_expired'
  );
  const persisted = await harness.database.read();
  assert.equal(persisted.wallets[account.address.toLowerCase()].profile.bankedNuggets, 0);
});

test('Practice rewards remain pending until the exact quoted payment verifies', async () => {
  const harness = createHarness();
  const session = await signIn(harness);
  await enableEconomy(harness);
  const run = await harness.service.startRun(session.token, SERVER_RUN_MODES.PRACTICE);
  harness.advance(60_000);
  const finished = await harness.service.finishRun(session.token, {
    runId: run.runId,
    runToken: run.runToken,
    result: {
      extracted: true,
      projected: 2_500,
      banked: 2_500,
      depth: 1,
      kills: 5,
      oreBroken: 5,
      elapsed: 60
    }
  });
  assert.equal(finished.profile.bankedNuggets, 0);
  assert.equal(finished.practiceClaim.status, 'pending');

  const quoted = await harness.service.quotePracticeClaim(session.token, { runId: run.runId });
  assert.equal(quoted.quote.nuggets, 2_500);
  assert.equal(quoted.quote.amountAtomic, '5000000000000000000000');
  const claimed = await harness.service.practiceRunClaim(session.token, {
    action: 'claim',
    runId: run.runId,
    quoteId: quoted.quote.id,
    transactionHash: TX_B
  });
  assert.equal(claimed.profile.bankedNuggets, 2_500);
  assert.equal(claimed.practiceClaim.status, 'claimed');
  assert.equal(claimed.ledgerEntry.type, 'PRACTICE_CLAIM');
});

test('exact verifier rejects underpayment, overpayment, wrong recipient, and wrong chain-call shape', async () => {
  const expected = account.address;
  const recipient = '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc';
  const baseQuote = {
    asset: 'RON',
    amountAtomic: '100',
    recipient,
    mattTokenAddress: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d'
  };

  for (const [name, transaction, code] of [
    ['underpayment', { from: expected, to: recipient, value: 99n, input: '0x' }, 'payment_amount_mismatch'],
    ['overpayment', { from: expected, to: recipient, value: 101n, input: '0x' }, 'payment_amount_mismatch'],
    ['wrong recipient', { from: expected, to: secondAccount.address, value: 100n, input: '0x' }, 'wrong_payment_recipient'],
    ['contract call', { from: expected, to: recipient, value: 100n, input: '0x1234' }, 'invalid_payment_call']
  ]) {
    const verifier = new DirectRoninNuggetPaymentVerifier({
      confirmations: 1,
      client: {
        async waitForTransactionReceipt() {
          return { status: 'success', to: transaction.to, blockNumber: 99n, logs: [] };
        },
        async getTransaction() {
          return transaction;
        }
      }
    });
    await assert.rejects(
      verifier.verifyExactTransfer(TX_C, expected, baseQuote),
      (error) => error.code === code,
      name
    );
  }
});
