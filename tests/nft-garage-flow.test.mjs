import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NftGarageClient,
  NFT_GARAGE_CONTRACTS,
  NFT_GARAGE_MAX_CHESTS_PER_PURCHASE,
  NFT_GARAGE_SELECTORS,
  crystalWithdrawalAvailability,
  formatTokenUnits,
  parseTokenUnits,
  uintWord
} from '../src/game/nftGarageClient.js';
import { validatedNftLabRpcRequest } from '../server/http.js';

function garageHarness() {
  const calls = [];
  const garage = new NftGarageClient({
    wallet: { async sendPreparedTransaction() {} },
    fetch: async () => ({ ok: true, json: async () => ({ result: '0x' }) })
  });
  garage.send = async (to, data, kind, options) => calls.push({ to, data, kind, options });
  return { garage, calls };
}

test('the unified Garage reads the activated Crystal Bank through the same-origin RPC', () => {
  const request = validatedNftLabRpcRequest({
    id: 1,
    method: 'eth_call',
    params: [{
      to: NFT_GARAGE_CONTRACTS.crystalBank,
      data: `${NFT_GARAGE_SELECTORS.bankBalance}${'1'.padStart(64, '0')}`
    }, 'latest']
  });
  assert.equal(request.params[0].to, NFT_GARAGE_CONTRACTS.crystalBank.toLowerCase());

  const walletBalanceRequest = validatedNftLabRpcRequest({
    id: 2,
    method: 'eth_call',
    params: [{
      to: NFT_GARAGE_CONTRACTS.crystal,
      data: `${NFT_GARAGE_SELECTORS.balanceOf}${'1'.padStart(64, '0')}`
    }, 'latest']
  });
  assert.equal(walletBalanceRequest.params[0].to, NFT_GARAGE_CONTRACTS.crystal.toLowerCase());
});

test('Crystal withdrawal amounts round-trip without floating point loss', () => {
  const raw = parseTokenUnits('123.456789');
  assert.equal(raw, 123_456789_000000000000n);
  assert.equal(formatTokenUnits(raw, 18, 6), '123.456789');
});

test('Crystal withdrawal availability caps Max by bank, wallet, and global UTC limits', () => {
  const available = crystalWithdrawalAvailability({
    crystalBalanceRaw: 500n,
    minimumWithdrawalRaw: 100n,
    walletDailyLimitRaw: 1_000n,
    walletWithdrawnRaw: 700n,
    globalDailyLimitRaw: 10_000n,
    globalWithdrawnRaw: 9_800n,
    crystalBankPaused: false
  });

  assert.equal(available.walletRemainingRaw, 300n);
  assert.equal(available.globalRemainingRaw, 200n);
  assert.equal(available.withdrawableRaw, 200n);
  assert.equal(available.withdrawalAvailable, true);
  assert.equal(crystalWithdrawalAvailability({ ...available, crystalBankPaused: true }).withdrawableRaw, 0n);
});

test('the wallet Crystal Bank snapshot reads UTC usage without requiring a selected Miner', async () => {
  const address = '0x1111111111111111111111111111111111111111';
  const now = Date.UTC(2026, 7, 22, 12);
  const day = Math.floor(now / 86_400_000);
  const calls = [];
  const garage = new NftGarageClient({
    wallet: { async sendPreparedTransaction() {} },
    now: () => now,
    fetch: async () => ({ ok: true, json: async () => ({ result: '0x' }) })
  });
  garage.call = async (to, data) => {
    calls.push({ to, data });
    const value = to === NFT_GARAGE_CONTRACTS.crystal ? 1_250n
      : data.startsWith(NFT_GARAGE_SELECTORS.bankBalance) ? 900n
      : data === NFT_GARAGE_SELECTORS.minimumWithdrawal ? 100n
        : data === NFT_GARAGE_SELECTORS.walletDailyLimit ? 1_000n
          : data === NFT_GARAGE_SELECTORS.globalDailyLimit ? 10_000n
            : data.startsWith(NFT_GARAGE_SELECTORS.walletWithdrawn) ? 250n
              : data.startsWith(NFT_GARAGE_SELECTORS.globalWithdrawn) ? 9_500n
                : 0n;
    return `0x${value.toString(16).padStart(64, '0')}`;
  };

  const snapshot = await garage.walletSnapshot({ address });

  assert.equal(snapshot.utcDay, day);
  assert.equal(snapshot.walletCrystalBalanceRaw, 1_250n);
  assert.equal(snapshot.nextUtcResetAt, Date.UTC(2026, 7, 23));
  assert.equal(snapshot.walletRemainingRaw, 750n);
  assert.equal(snapshot.globalRemainingRaw, 500n);
  assert.equal(snapshot.withdrawableRaw, 500n);
  assert.ok(calls.some((call) => call.data === `${NFT_GARAGE_SELECTORS.walletWithdrawn}${day.toString(16).padStart(64, '0')}${address.slice(2).padStart(64, '0')}`));
});

test('Crystal withdrawals reject amounts beyond the currently withdrawable limit', async () => {
  const { garage, calls } = garageHarness();
  const unit = 10n ** 18n;
  const snapshot = crystalWithdrawalAvailability({
    crystalBalanceRaw: 900n * unit,
    minimumWithdrawalRaw: 100n * unit,
    walletDailyLimitRaw: 500n * unit,
    walletWithdrawnRaw: 100n * unit,
    globalDailyLimitRaw: 10_000n * unit,
    globalWithdrawnRaw: 9_700n * unit,
    crystalBankPaused: false
  });

  await assert.rejects(() => garage.withdrawCrystals(snapshot, 301n * unit), /Only 300 MATT/);
  await garage.withdrawCrystals(snapshot, 300n * unit, { onBroadcast() {} });
  assert.equal(calls[0].kind, 'crystal-withdrawal');
  assert.equal(typeof calls[0].options.onBroadcast, 'function');
});

test('first-time replacement explains the immutable three-transaction contract sequence', async () => {
  const { garage, calls } = garageHarness();
  await garage.equip({
    minerId: 1000,
    runLocked: false,
    loadout: { armor: 4 },
    equipmentOperatorApproved: false
  }, { tokenId: 9, slot: 0 });

  assert.deepEqual(calls.map((call) => call.kind), ['unequip', 'equipment-approval', 'equip']);
  assert.deepEqual(calls.map((call) => call.to), [
    NFT_GARAGE_CONTRACTS.loadout,
    NFT_GARAGE_CONTRACTS.equipment,
    NFT_GARAGE_CONTRACTS.loadout
  ]);
});

test('later equips reuse the approved Loadout operator and require one transaction', async () => {
  const { garage, calls } = garageHarness();
  await garage.equip({
    minerId: 1000,
    runLocked: false,
    loadout: { helmet: 0 },
    equipmentOperatorApproved: true
  }, { tokenId: 10, slot: 4 });

  assert.deepEqual(calls.map((call) => call.kind), ['equip']);
});

test('the Garage refuses equipment changes while the Miner is locked in a run', async () => {
  const { garage, calls } = garageHarness();
  await assert.rejects(
    () => garage.equip({ minerId: 1000, runLocked: true, loadout: {}, equipmentOperatorApproved: true }, { tokenId: 10, slot: 4 }),
    /locked in a run/
  );
  assert.deepEqual(calls, []);
});

test('Equipment chest purchases batch up to ten independent chests in one transaction', async () => {
  const { garage, calls } = garageHarness();
  const address = '0x1111111111111111111111111111111111111111';
  let allowance;
  garage.ensureMattAllowance = async (...args) => { allowance = args; };

  const purchase = await garage.openChests(
    { address, chestBatchLimit: NFT_GARAGE_MAX_CHESTS_PER_PURCHASE },
    { slot: 4, priceRaw: 5n },
    NFT_GARAGE_MAX_CHESTS_PER_PURCHASE
  );

  assert.equal(allowance[2], 50n);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].to, NFT_GARAGE_CONTRACTS.chest);
  assert.equal(calls[0].data, `${NFT_GARAGE_SELECTORS.openChests}${uintWord(4)}${uintWord(10)}`);
  assert.deepEqual(purchase, { quantity: 10, totalPriceRaw: 50n, batched: true, transactionCount: 1 });
});

test('Equipment chest quantity stays capped at ten and falls back safely before the contract upgrade', async () => {
  const { garage, calls } = garageHarness();
  const address = '0x1111111111111111111111111111111111111111';
  const progress = [];
  garage.ensureMattAllowance = async () => {};

  await assert.rejects(
    () => garage.openChests({ address, chestBatchLimit: 10 }, { slot: 1, priceRaw: 2n }, 11),
    /no more than 10/
  );
  const purchase = await garage.openChests(
    { address, chestBatchLimit: 1 },
    { slot: 1, priceRaw: 2n },
    3,
    { onProgress: (status) => progress.push(status) }
  );

  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => call.data === `${NFT_GARAGE_SELECTORS.openChest}${uintWord(1)}`));
  assert.deepEqual(progress.at(-1), { completed: 3, quantity: 3 });
  assert.deepEqual(purchase, { quantity: 3, totalPriceRaw: 6n, batched: false, transactionCount: 3 });

  const partial = garageHarness().garage;
  let attempts = 0;
  partial.ensureMattAllowance = async () => {};
  partial.send = async () => {
    attempts += 1;
    if (attempts === 3) throw new Error('wallet sequence stopped');
  };
  await assert.rejects(
    () => partial.openChests({ address, chestBatchLimit: 1 }, { slot: 1, priceRaw: 2n }, 4),
    (error) => {
      assert.equal(error.completedChestPurchases, 2);
      assert.equal(error.requestedChestPurchases, 4);
      return true;
    }
  );
});

test('the Garage detects the on-chain chest batch limit and defaults legacy contracts to one', async () => {
  const { garage } = garageHarness();
  garage.call = async () => `0x${10n.toString(16).padStart(64, '0')}`;
  assert.equal(await garage.chestBatchLimit(), 10);
  garage.call = async () => { throw new Error('unknown selector'); };
  assert.equal(await garage.chestBatchLimit(), 1);
});
