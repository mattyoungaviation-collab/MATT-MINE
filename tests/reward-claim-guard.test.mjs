import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MATT_REWARDS_CONTRACT,
  MATT_REWARD_CLAIM_SELECTOR,
  RoninWalletAdapter,
  validateRewardClaimTransaction
} from '../src/game/walletAdapter.js';

const PLAYER = '0x1dab596d0121c250a24b00137e84170fa6874be6';
const WRONG_CONTRACT = '0x2b7d130bb4b026b9eaf045acac4e69238f2d2fd3';
const WRONG_SELECTOR = '0x6a139974';
const HASH = `0x${'9'.repeat(64)}`;

function validClaim(overrides = {}) {
  return {
    to: MATT_REWARDS_CONTRACT,
    value: '0x0',
    data: `${MATT_REWARD_CLAIM_SELECTOR}${'0'.repeat(64 * 6)}`,
    ...overrides
  };
}

function adapterFor(provider) {
  const adapter = new RoninWalletAdapter({
    api: { hasSession: () => true },
    window: { ronin: { provider } }
  });
  adapter.player = { address: PLAYER };
  adapter.provider = provider;
  return adapter;
}

test('reward claims are pinned to the deployed MATT rewards contract and claim selector', () => {
  assert.doesNotThrow(() => validateRewardClaimTransaction(validClaim()));
  assert.throws(
    () => validateRewardClaimTransaction(validClaim({ to: WRONG_CONTRACT })),
    (error) => {
      assert.match(error.message, /blocked an unsafe MATT claim/i);
      assert.match(error.message, new RegExp(WRONG_CONTRACT, 'i'));
      return true;
    }
  );
  assert.throws(
    () => validateRewardClaimTransaction(validClaim({ data: `${WRONG_SELECTOR}${'0'.repeat(128)}` })),
    (error) => {
      assert.match(error.message, /blocked an unsafe MATT claim/i);
      assert.match(error.message, new RegExp(WRONG_SELECTOR, 'i'));
      return true;
    }
  );
});

test('an unsafe prepared claim is rejected before Ronin Wallet can charge gas', async () => {
  const calls = [];
  const provider = {
    async request(payload) {
      calls.push(payload);
      throw new Error(`Unexpected ${payload.method}`);
    }
  };
  const adapter = adapterFor(provider);

  await assert.rejects(
    () => adapter.claimReward(validClaim({
      to: WRONG_CONTRACT,
      data: `${WRONG_SELECTOR}${'0'.repeat(128)}`
    })),
    /blocked an unsafe MATT claim/i
  );
  assert.equal(calls.length, 0);
});

test('a valid reward claim submits the exact server prepared transaction', async () => {
  const expected = validClaim();
  const calls = [];
  const provider = {
    async request(payload) {
      calls.push(payload);
      if (payload.method === 'eth_requestAccounts') return [PLAYER];
      if (payload.method === 'eth_chainId') return '0x7e4';
      if (payload.method === 'eth_sendTransaction') return HASH;
      if (payload.method === 'eth_getTransactionReceipt') return { status: '0x1' };
      if (payload.method === 'eth_getTransactionByHash') {
        return { to: expected.to, input: expected.data };
      }
      throw new Error(`Unexpected ${payload.method}`);
    }
  };
  const adapter = adapterFor(provider);

  assert.equal(await adapter.claimReward(expected), HASH);
  const sent = calls.find((entry) => entry.method === 'eth_sendTransaction');
  assert.deepEqual(sent.params[0], {
    from: PLAYER,
    to: expected.to,
    value: '0x0',
    data: expected.data
  });
});

test('the client reports when Ronin broadcasts the unrelated transaction seen in production', async () => {
  const expected = validClaim();
  const provider = {
    async request(payload) {
      if (payload.method === 'eth_requestAccounts') return [PLAYER];
      if (payload.method === 'eth_chainId') return '0x7e4';
      if (payload.method === 'eth_sendTransaction') return HASH;
      if (payload.method === 'eth_getTransactionReceipt') return { status: '0x1' };
      if (payload.method === 'eth_getTransactionByHash') {
        return {
          to: WRONG_CONTRACT,
          input: `${WRONG_SELECTOR}${'0'.repeat(128)}`
        };
      }
      throw new Error(`Unexpected ${payload.method}`);
    }
  };
  const adapter = adapterFor(provider);

  await assert.rejects(
    () => adapter.claimReward(expected),
    (error) => {
      assert.match(error.message, /broadcast a different transaction/i);
      assert.match(error.message, new RegExp(WRONG_CONTRACT, 'i'));
      assert.match(error.message, new RegExp(WRONG_SELECTOR, 'i'));
      assert.match(error.message, new RegExp(HASH, 'i'));
      return true;
    }
  );
});
