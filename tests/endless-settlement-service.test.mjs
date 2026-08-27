import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { EndlessSettlementService } from '../server/endless-settlement-service.js';

const OPERATOR_KEY = `0x${'11'.repeat(32)}`;
const SIGNER_KEY = `0x${'22'.repeat(32)}`;
const OPERATOR = privateKeyToAccount(OPERATOR_KEY);
const SIGNER = privateKeyToAccount(SIGNER_KEY);
const PLAYER = '0x1111111111111111111111111111111111111111';
const SETTLEMENT = '0x2222222222222222222222222222222222222222';
const LOADOUT = '0x3333333333333333333333333333333333333333';
const VERSION = `0x${'44'.repeat(32)}`;
const LOADOUT_HASH = `0x${'55'.repeat(32)}`;
const ZERO = `0x${'00'.repeat(32)}`;
const ECONOMY = Object.freeze({
  crystalConversionNumerator: 1,
  crystalConversionDenominator: 400,
  maximumPayoutNumerator: 10,
  maximumPayoutDenominator: 1,
  maximumDailyPayoutNumerator: 500,
  maximumDailyPayoutDenominator: 1,
  mineableCrystalUnits: 3_750,
  maximumPhases: 1_000_000,
  phaseXp: 10,
  maximumRunXp: 500,
  maximumWalletXpPerDay: 2_500,
  maximumMinerXpPerDay: 2_500,
  checkpointTimeoutSeconds: 86_400,
  failedRunsRetainXp: false
});

function harness(options = {}) {
  let transaction = 0;
  let active = emptyActive();
  let settledEvent = null;
  let settlementSimulation = null;
  const publicClient = {
    async getChainId() { return 2020; },
    async getBalance() { return 10n ** 18n; },
    async waitForTransactionReceipt() { return { status: 'success', logs: [] }; },
    async getLogs() { return settledEvent ? [settledEvent] : []; },
    async simulateContract(request) {
      settlementSimulation = request;
      if (options.settlementSimulationError) throw options.settlementSimulationError;
      return { request };
    },
    async readContract({ functionName }) {
      if (functionName === 'OPERATOR_ROLE') return `0x${'66'.repeat(32)}`;
      if (functionName === 'paused') return false;
      if (functionName === 'rewardSigner') return SIGNER.address;
      if (functionName === 'loadout') return LOADOUT;
      if (functionName === 'crystalUnit') return 10n ** 18n;
      if (functionName === 'hasRole') return true;
      if (functionName === 'versions') return {
        generatorHash: `0x${'77'.repeat(32)}`,
        configHash: `0x${'88'.repeat(32)}`,
        conversionRate: 2_500_000_000_000_000n,
        maximumPayout: 10n * 10n ** 18n,
        maximumDailyPayout: 500n * 10n ** 18n,
        mineableCrystalUnits: 3_750,
        maximumPhases: 1_000_000,
        phaseXp: 10,
        maximumRunXp: 500,
        maximumWalletXpPerDay: 2_500,
        maximumMinerXpPerDay: 2_500,
        checkpointTimeout: 86_400,
        failedRunsRetainXp: false,
        approved: true,
        retired: false
      };
      if (functionName === 'playerNonces') return 0n;
      if (functionName === 'loadoutHash') return LOADOUT_HASH;
      if (functionName === 'activeRun') return active;
      throw new Error(`Unexpected read ${functionName}`);
    }
  };
  const operatorClient = {
    async writeContract({ functionName, args }) {
      transaction += 1;
      if (functionName === 'beginRun') {
        const authorization = args[0];
        active = {
          ...emptyActive(),
          runId: `0x${'99'.repeat(32)}`,
          versionId: authorization.versionId,
          loadoutHash: authorization.loadoutHash,
          player: authorization.player,
          nonce: authorization.nonce
        };
      } else if (functionName === 'checkpoint') {
        const receipt = args[0];
        active = {
          ...active,
          checkpointDigest: receipt.checkpointDigest,
          completedPhases: receipt.completedPhases,
          minedCrystalUnits: receipt.minedCrystalUnits
        };
      } else if (functionName === 'settle') {
        const result = args[0];
        settledEvent = {
          transactionHash: `0x${transaction.toString(16).padStart(64, '0')}`,
          args: {
            runId: result.runId,
            completedPhases: result.completedPhases,
            minedCrystalUnits: result.minedCrystalUnits,
            xpBanked: 10n,
            crystalsBanked: 10n ** 18n
          }
        };
        active = emptyActive();
      }
      return `0x${transaction.toString(16).padStart(64, '0')}`;
    }
  };
  const service = new EndlessSettlementService({
    enabled: true,
    chainId: 2020,
    rpcUrl: 'https://rpc.example.test',
    settlementAddress: SETTLEMENT,
    loadoutAddress: LOADOUT,
    operatorAddress: OPERATOR.address,
    signerAddress: SIGNER.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    versionIds: { 'endless-conservative-v1': VERSION },
    publicClient,
    operatorClient
  });
  return { service, activeRun: () => active, settlementSimulation: () => settlementSimulation };
}

test('Endless chain adapter authorizes, checkpoints, and settles one immutable version', async () => {
  const { service } = harness();
  await service.init();
  const prepared = await service.prepareRunAuthorization({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY
  });
  assert.equal(prepared.typedData.primaryType, 'EndlessRunAuthorization');
  assert.equal(prepared.authorization.versionId, VERSION);

  const started = await service.beginRun({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY,
    authorization: prepared.authorization,
    playerSignature: `0x${'12'.repeat(65)}`
  });
  assert.equal(started.chainRun.completedPhases, 0);

  const checkpointed = await service.checkpoint({
    address: PLAYER,
    minerId: 7,
    chainRun: started.chainRun,
    completedPhases: 1,
    minedCrystalUnits: 3,
    rollingDigest: 'ab'.repeat(32)
  });
  assert.equal(checkpointed.chainRun.completedPhases, 1);
  assert.equal(checkpointed.chainRun.checkpointDigest, `0x${'ab'.repeat(32)}`);

  const settled = await service.settle({
    address: PLAYER,
    minerId: 7,
    chainRun: checkpointed.chainRun,
    completedPhases: 1,
    minedCrystalUnits: 3,
    rollingDigest: 'ab'.repeat(32),
    outcome: 'extraction'
  });
  assert.equal(settled.crystalsBanked, 1);
  assert.equal(settled.minerXpBanked, 10);
});

test('Endless chain adapter releases a failed start through signed zero-phase settlement', async () => {
  const { service, activeRun } = harness();
  await service.init();
  const prepared = await service.prepareRunAuthorization({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY
  });
  const started = await service.beginRun({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY,
    authorization: prepared.authorization,
    playerSignature: `0x${'12'.repeat(65)}`
  });
  const cancelled = await service.cancelUnstarted({ minerId: 7, chainRun: started.chainRun });
  assert.equal(cancelled.recovered, false);
  assert.notEqual(cancelled.transactionHash, '');
  assert.equal(activeRun().runId, ZERO);
});

test('Endless chain adapter death-settles a progressed orphan from live chain state', async () => {
  const { service, activeRun } = harness();
  await service.init();
  const prepared = await service.prepareRunAuthorization({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY
  });
  const started = await service.beginRun({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY,
    authorization: prepared.authorization,
    playerSignature: `0x${'12'.repeat(65)}`
  });
  await service.checkpoint({
    address: PLAYER,
    minerId: 7,
    chainRun: started.chainRun,
    completedPhases: 1,
    minedCrystalUnits: 3,
    rollingDigest: 'ab'.repeat(32)
  });

  const cancelled = await service.cancelRun({ address: PLAYER, minerId: 7 });

  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.settlement.completedPhases, 1);
  assert.equal(cancelled.settlement.minedCrystalUnits, 3);
  assert.notEqual(cancelled.transactionHash, '');
  assert.equal(activeRun().runId, ZERO);
});

test('Endless chain adapter exposes a safe exact Ronin reason before broadcasting a failed close', async () => {
  const simulationError = new Error("Execution reverted with custom error 'MinerNotInRun(7)'.");
  const { service } = harness({ settlementSimulationError: simulationError });
  await service.init();
  const prepared = await service.prepareRunAuthorization({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY
  });
  await service.beginRun({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: ECONOMY,
    authorization: prepared.authorization,
    playerSignature: `0x${'12'.repeat(65)}`
  });

  await assert.rejects(
    service.cancelRun({ address: PLAYER, minerId: 7 }),
    (error) => error.code === 'endless_chain_settlement_failed' &&
      error.details?.reason === 'MinerNotInRun' &&
      /remains saved and can be retried/i.test(error.message)
  );
});

test('Endless chain adapter fails closed when Admin economy values do not match the mapped version', async () => {
  const { service } = harness();
  await service.init();
  await assert.rejects(service.prepareRunAuthorization({
    address: PLAYER,
    minerId: 7,
    economyVersion: 'endless-conservative-v1',
    economyConfig: { ...ECONOMY, maximumPayoutNumerator: 11 }
  }), /does not match its approved on-chain version/i);
});

function emptyActive() {
  return {
    runId: ZERO,
    versionId: ZERO,
    loadoutHash: ZERO,
    checkpointDigest: ZERO,
    player: '0x0000000000000000000000000000000000000000',
    conversionRate: 0n,
    maximumPayout: 0n,
    maximumDailyPayout: 0n,
    startedAt: 0,
    lastCheckpointAt: 0,
    mineableCrystalUnits: 0,
    maximumPhases: 0,
    phaseXp: 0,
    maximumRunXp: 0,
    maximumWalletXpPerDay: 0,
    maximumMinerXpPerDay: 0,
    checkpointTimeout: 0,
    completedPhases: 0,
    minedCrystalUnits: 0,
    carryCapacity: 0,
    deathRetentionBps: 0,
    failedRunsRetainXp: false,
    nonce: 0n
  };
}
