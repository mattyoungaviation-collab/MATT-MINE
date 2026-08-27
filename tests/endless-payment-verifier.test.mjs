import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  parseUnits
} from 'viem';

import {
  ENDLESS_MATT_ABI,
  EndlessMattPaymentVerifier
} from '../server/endless-payment-verifier.js';
import { MATT_TOKEN_ADDRESS, REWARD_TREASURY_ADDRESS } from '../server/reward-plan.js';

const PLAYER = '0x1111111111111111111111111111111111111111';
const HASH = `0x${'ab'.repeat(32)}`;

function harness(overrides = {}) {
  const amount = parseUnits('2500000', 18);
  const transaction = new EndlessMattPaymentVerifier({ client: {} }).transactionForPayment(2_500_000);
  const topics = encodeEventTopics({
    abi: ENDLESS_MATT_ABI,
    eventName: 'Transfer',
    args: { from: PLAYER, to: REWARD_TREASURY_ADDRESS }
  });
  const client = {
    async getChainId() { return 2020; },
    async getCode() { return '0x6000'; },
    async readContract({ functionName }) {
      return ({ name: 'Matt', symbol: 'MATT', decimals: 18 })[functionName];
    },
    async waitForTransactionReceipt() {
      return {
        status: 'success',
        to: MATT_TOKEN_ADDRESS,
        blockNumber: 123n,
        logs: [{
          address: MATT_TOKEN_ADDRESS,
          topics,
          data: encodeAbiParameters([{ type: 'uint256' }], [amount]),
          logIndex: 4,
          transactionHash: HASH,
          blockNumber: 123n
        }]
      };
    },
    async getTransaction() {
      return { from: PLAYER, to: MATT_TOKEN_ADDRESS, value: 0n, input: transaction.data };
    },
    async getBlock() { return { timestamp: 1_787_788_800n }; },
    ...overrides
  };
  return { client, transaction };
}

test('Endless MATT verifier pins trusted metadata and prepares an exact Treasury Safe transfer', async () => {
  const { client } = harness();
  const verifier = await new EndlessMattPaymentVerifier({ client, confirmations: 7 }).init();
  const status = verifier.publicStatus();
  assert.equal(status.configured, true);
  assert.equal(status.chainId, 2020);
  assert.equal(status.token, getAddress(MATT_TOKEN_ADDRESS));
  assert.equal(status.recipient, getAddress(REWARD_TREASURY_ADDRESS));
  assert.equal(status.confirmations, 7);
  const prepared = verifier.transactionForPayment(2_500_000);
  assert.equal(prepared.to, getAddress(MATT_TOKEN_ADDRESS));
  assert.equal(prepared.value, '0x0');
  const decoded = decodeFunctionData({ abi: ENDLESS_MATT_ABI, data: prepared.data });
  assert.equal(decoded.functionName, 'transfer');
  assert.equal(decoded.args[0], getAddress(REWARD_TREASURY_ADDRESS));
  assert.equal(decoded.args[1], parseUnits('2500000', 18));
});

test('Endless MATT verifier accepts only the exact payer, amount, token, recipient, event, and confirmations', async () => {
  const { client } = harness();
  const verifier = await new EndlessMattPaymentVerifier({ client, confirmations: 5 }).init();
  const payment = await verifier.verifyPayment({ transactionHash: HASH, address: PLAYER, mattPrice: 2_500_000 });
  assert.equal(payment.transactionHash, HASH);
  assert.equal(payment.logIndex, 4);
  assert.equal(payment.amountMatt, 2_500_000);
  assert.equal(payment.amountRaw, parseUnits('2500000', 18).toString());
  assert.equal(payment.payer, PLAYER);
  assert.equal(payment.recipient, REWARD_TREASURY_ADDRESS.toLowerCase());
  assert.equal(payment.confirmations, 5);
});

test('Endless MATT verifier rejects a transfer sent by another wallet', async () => {
  const { client } = harness({
    async getTransaction() {
      const verifier = new EndlessMattPaymentVerifier({ client: {} });
      return {
        from: '0x2222222222222222222222222222222222222222',
        to: MATT_TOKEN_ADDRESS,
        value: 0n,
        input: verifier.transactionForPayment(2_500_000).data
      };
    }
  });
  const verifier = await new EndlessMattPaymentVerifier({ client }).init();
  await assert.rejects(
    () => verifier.verifyPayment({ transactionHash: HASH, address: PLAYER, mattPrice: 2_500_000 }),
    (error) => error.code === 'payment_wallet_mismatch'
  );
});

test('Endless MATT verifier fails startup against token metadata drift', async () => {
  const { client } = harness({
    async readContract({ functionName }) {
      return ({ name: 'Fake Matt', symbol: 'MATT', decimals: 18 })[functionName];
    }
  });
  await assert.rejects(
    () => new EndlessMattPaymentVerifier({ client }).init(),
    (error) => error.code === 'endless_payment_token_mismatch'
  );
});
