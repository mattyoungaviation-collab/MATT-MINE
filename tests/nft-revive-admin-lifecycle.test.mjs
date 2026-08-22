import test from 'node:test';
import assert from 'node:assert/strict';

import { MemoryDatabase } from '../server/database.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { RONIN_CHAINS, SERVER_RUN_MODES } from '../server/constants.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const ORIGIN = 'http://localhost:4173';
const START = Date.UTC(2026, 7, 22, 0, 0, 0);
const RUN_ID = `run_${'a'.repeat(24)}`;

async function signIn(service) {
  const challenge = await service.createChallenge({
    address: ADDRESS,
    chainId: RONIN_CHAINS.MAINNET,
    origin: ORIGIN
  });
  const session = await service.verifyChallenge({
    address: ADDRESS,
    nonce: challenge.nonce,
    signature: `0x${'11'.repeat(65)}`
  });
  return session.token;
}

test('all server paid-revive mutations stop while Admin termination owns the run', async () => {
  let eligibilityChecks = 0;
  let paymentChecks = 0;
  const database = new MemoryDatabase();
  const service = new CompleteProductionMattMineService(database, {
    now: () => START,
    chainId: RONIN_CHAINS.MAINNET,
    publicOrigin: ORIGIN,
    adminKey: 'admin-secret',
    verifySignature: async () => true,
    reviveEligibilityValidator: {
      async validate() {
        eligibilityChecks += 1;
        return {};
      }
    },
    revivePaymentVerifier: {
      publicStatus: () => ({ configured: true }),
      transactionForPayment: () => ({ to: ADDRESS, value: '0x1', data: '0x' }),
      async verifyPayment() {
        paymentChecks += 1;
        return {};
      }
    }
  });
  const token = await signIn(service);
  await database.transact((state) => {
    state.runs[RUN_ID] = {
      id: RUN_ID,
      address: ADDRESS,
      mode: SERVER_RUN_MODES.PAID,
      status: 'awaiting-revive',
      startedAt: START,
      expiresAt: START + 60_000,
      paidReviveEligible: true,
      pendingRevive: {
        id: 'pending-admin-revive',
        status: 'pending',
        priceRonWei: '1'
      },
      adminTerminationPending: {
        id: 'adminterm-revive',
        requestedAt: START,
        context: 'Support termination'
      },
      revives: []
    };
    state.expansionConfig.settings.paidRevivesEnabled = true;
  });

  const attempts = [
    () => service.requestPaidRevive(token, { runId: RUN_ID, deathState: {} }),
    () => service.confirmPaidRevive(token, {
      runId: RUN_ID,
      transactionHash: `0x${'2'.repeat(64)}`
    }),
    () => service.resumePaidRevive(token, RUN_ID),
    () => service.cancelPaidRevive(token, RUN_ID)
  ];
  for (const attempt of attempts) {
    await assert.rejects(
      attempt,
      (error) => error.code === 'run_admin_termination_pending'
    );
  }

  const run = (await database.read()).runs[RUN_ID];
  assert.equal(run.status, 'awaiting-revive');
  assert.equal(run.pendingRevive.status, 'pending');
  assert.equal(eligibilityChecks, 0);
  assert.equal(paymentChecks, 0);
});
