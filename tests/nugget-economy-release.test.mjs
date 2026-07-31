import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { privateKeyToAccount } from 'viem/accounts';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { MemoryNuggetEconomyStore } from '../server/nugget-economy.js';
import { RONIN_CHAINS } from '../server/constants.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const account = privateKeyToAccount(PRIVATE_KEY);
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 6, 28, 12, 0, 0);
const HASH = `0x${'d'.repeat(64)}`;

function harness() {
  let timestamp = START;
  let randomCounter = 0;
  const database = new MemoryDatabase();
  const economyStore = new MemoryNuggetEconomyStore();
  const verifier = {
    transactionForQuote(quote) {
      return { to: quote.mattTokenAddress, value: '0x0', data: '0xa9059cbb' };
    },
    async verifyExactTransfer() {
      return { blockNumber: '1' };
    }
  };
  const service = new CompleteProductionMattMineService(database, {
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
    service,
    economyStore,
    advance(milliseconds) {
      timestamp += milliseconds;
    }
  };
}

async function signIn(context) {
  const challenge = await context.service.createChallenge({
    address: account.address,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const signature = await account.signMessage({ message: challenge.message });
  return context.service.verifyChallenge({
    address: account.address,
    nonce: challenge.nonce,
    signature
  });
}

test('an expired verifying quote releases its transaction reservation and UTC cap capacity', async () => {
  const context = harness();
  const session = await signIn(context);
  await context.service.updateAdminNuggetEconomy('test-admin-key', {
    purchasesEnabled: true,
    dailyPurchaseCap: 1_000_000,
    quoteTtlMs: 30_000,
    packages: [{
      id: 'six-hundred-k',
      name: '600,000 Nuggets',
      nuggets: 600_000,
      displayedUsd: 3,
      enabled: true,
      prices: { MATT: '3000000000000000000000', RON: '0' }
    }]
  }, 'Enable expiry reservation test package.');
  const first = await context.service.quoteNuggetPurchase(session.token, { packageId: 'six-hundred-k' });
  await context.economyStore.transact((state) => {
    state.quotes[first.quote.id].status = 'verifying';
    state.quotes[first.quote.id].transactionHash = HASH;
    state.usedTransactions[HASH] = {
      quoteId: first.quote.id,
      address: account.address.toLowerCase(),
      purpose: 'purchase',
      reservedAt: START,
      confirmedAt: 0
    };
  });
  context.advance(30_001);
  const second = await context.service.quoteNuggetPurchase(session.token, { packageId: 'six-hundred-k' });
  assert.equal(second.quote.nuggets, 600_000);
  const state = await context.economyStore.read();
  assert.equal(state.quotes[first.quote.id].status, 'expired');
  assert.equal(state.usedTransactions[HASH], undefined);
});

test('player and Admin interfaces expose the structured production economy without manual hash claiming', async () => {
  const [shop, productionCss, practice, adminHtml, adminScript, preferences, documentation] = await Promise.all([
    readFile(new URL('../src/nuggetShop.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/production.css', import.meta.url), 'utf8'),
    readFile(new URL('../src/practiceClaimFlow.js', import.meta.url), 'utf8'),
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/adminEconomy.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/game/preferences.js', import.meta.url), 'utf8'),
    readFile(new URL('../docs/nugget-economy.md', import.meta.url), 'utf8')
  ]);
  assert.match(shop, /NUGGET SHOP/);
  assert.match(shop, /purchases\/quote/);
  assert.match(shop, /purchases\/confirm/);
  assert.match(shop, /Your verified purchase history/);
  assert.doesNotMatch(shop, /createElement\(['"]style['"]\)/);
  assert.match(productionCss, /\.nugget-shop-panel/);
  assert.match(practice, /nuggets\/practice\/quote/);
  assert.match(practice, /quoteId/);
  assert.match(practice, /hashWrap\.hidden = true/);
  assert.doesNotMatch(practice, /Paste a valid 32-byte/);
  assert.match(adminHtml, /Nuggets per MATT/);
  assert.match(adminHtml, /UTC daily purchase cap/);
  assert.match(adminHtml, /Purchase packages/);
  assert.match(adminScript, /nuggetsPerMatt/);
  assert.match(adminScript, /dailyPurchaseCap/);
  assert.match(adminScript, /data-economy-package/);
  assert.match(preferences, /practiceClaimFlow/);
  assert.match(documentation, /MATT_MINE_NUGGET_PAYMENTS_ENABLED/);
  assert.match(documentation, /No MATT is burned/);
});
