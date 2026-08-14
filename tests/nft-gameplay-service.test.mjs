import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createNftGameplayServiceFromEnvironment,
  NftGameplayService
} from '../server/nft-gameplay-service.js';
import {
  completedPhaseCount,
  recordNftCrystalBank
} from '../server/complete-production-service.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';

function testPrivateKey(label) {
  return `0x${createHash('sha256').update(`matt-mine-nft-test:${label}`).digest('hex')}`;
}

const OPERATOR_KEY = testPrivateKey('operator');
const SIGNER_KEY = testPrivateKey('signer');
const PLAYER = '0x1111111111111111111111111111111111111111';
const SETTLEMENT = '0x2222222222222222222222222222222222222222';
const LOADOUT = '0x3333333333333333333333333333333333333333';
const MAP_VERSION = `0x${'aa'.repeat(32)}`;
const LOADOUT_HASH = `0x${'bb'.repeat(32)}`;
const RUN_ID = `0x${'cc'.repeat(32)}`;
const PLAYER_SIGNATURE = `0x${'11'.repeat(65)}`;

test('production gameplay accepts the existing legacy game-signer secret name', () => {
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  const service = createNftGameplayServiceFromEnvironment({}, {
    MATT_MINE_NFT_GAMEPLAY_ENABLED: 'true',
    MATT_MINE_NFT_CONTRACT_VERSION: '2',
    MATT_MINE_NFT_CHAIN_ID: '2020',
    MATT_MINE_NFT_RPC_URL: 'https://example.invalid',
    MATT_MINE_NFT_SETTLEMENT_ADDRESS: SETTLEMENT,
    MATT_MINE_NFT_LOADOUT_ADDRESS: LOADOUT,
    MATT_MINE_NFT_GAME_OPERATOR_ADDRESS: operator.address,
    MATT_MINE_NFT_REWARD_SIGNER_ADDRESS: signer.address,
    MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY: OPERATOR_KEY,
    MATT_MINE_NFT_GAME_SIGNER_PRIVATE_KEY: SIGNER_KEY,
    MATT_MINE_NFT_MAP_VERSIONS_JSON: JSON.stringify({ arena: MAP_VERSION, paid: MAP_VERSION })
  });
  assert.ok(service instanceof NftGameplayService);
});

function profile(overrides = {}) {
  return {
    version: 2,
    minerId: 1,
    owner: PLAYER,
    progression: { bankedXp: 0, level: 1, evolution: 0, crystalsPerHour: 0, earningStatus: 'Not Eligible' },
    gameplay: { maximumHealth: 50, armorShield: 125, carryCapacity: 1_500, armorEffective: true, runLocked: false },
    render: { layout: 'matt-miner-fixed-v2', baseEvolution: 'rookie-miner', layers: [], damagedArmorFlashRed: false },
    ...overrides
  };
}

function fakePublicClient(minerId = 1) {
  return {
    async readContract(call) {
      if (call.functionName === 'playerNonces') return 0n;
      if (call.functionName === 'loadoutHash') return LOADOUT_HASH;
      if (call.functionName === 'activeRun') return [
        RUN_ID, MAP_VERSION, LOADOUT_HASH, PLAYER, 10n ** 16n, 100_000n * 10n ** 18n,
        1n, 1_000_000, 7_200, 1_500, 1_000, 0n
      ];
      throw new Error(`Unexpected ${call.functionName} for Miner ${minerId}`);
    },
    async waitForTransactionReceipt() { return { status: 'success' }; }
  };
}

function authorization(minerId) {
  return {
    player: PLAYER,
    minerId: String(minerId),
    mapVersion: MAP_VERSION,
    loadoutHash: LOADOUT_HASH,
    nonce: '0',
    deadline: String(Math.floor(Date.now() / 1_000) + 600)
  };
}

test('NFT gameplay locks the owned Miner and pins armor health plus doubled crystal capacity', async () => {
  const calls = [];
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  const metadataService = {
    async minerProfile(id) {
      if (id !== 1) throw Object.assign(new Error('missing'), { status: 404 });
      return profile();
    }
  };
  const service = new NftGameplayService({
    enabled: true,
    chainId: 202601,
    rpcUrl: 'https://example.invalid',
    settlementAddress: SETTLEMENT,
    loadoutAddress: LOADOUT,
    operatorAddress: operator.address,
    signerAddress: signer.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    mapVersions: { arena: MAP_VERSION, paid: MAP_VERSION },
    metadataService,
    publicClient: fakePublicClient(),
    operatorClient: {
      async writeContract(call) { calls.push(call); return `0x${'12'.repeat(32)}`; }
    }
  });

  const started = await service.beginRun({
    address: PLAYER,
    minerId: 1,
    mode: 'paid',
    authorization: authorization(1),
    playerSignature: PLAYER_SIGNATURE
  });
  assert.equal(started.minerId, 1);
  assert.equal(started.profile.gameplay.maximumHealth, 50);
  assert.equal(started.crystalCarryLimit, 1_500);
  assert.equal(calls[0].functionName, 'beginRun');
  assert.equal(calls[0].args[0].minerId, 1n);
  assert.equal(calls[0].args[1], PLAYER_SIGNATURE);
});

test('NFT gameplay locks the Miner explicitly selected on the character screen', async () => {
  const calls = [];
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  const service = new NftGameplayService({
    enabled: true,
    chainId: 202601,
    rpcUrl: 'https://example.invalid',
    settlementAddress: SETTLEMENT,
    loadoutAddress: LOADOUT,
    operatorAddress: operator.address,
    signerAddress: signer.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    mapVersions: { arena: MAP_VERSION, paid: MAP_VERSION },
    metadataService: {
      async minerProfile(id) {
        if (id === 2) return profile({ minerId: 2 });
        throw Object.assign(new Error('missing'), { status: 404 });
      }
    },
    publicClient: fakePublicClient(2),
    operatorClient: { async writeContract(call) { calls.push(call); return `0x${'56'.repeat(32)}`; } }
  });

  const started = await service.beginRun({
    address: PLAYER,
    minerId: 2,
    mode: 'paid',
    authorization: authorization(2),
    playerSignature: PLAYER_SIGNATURE
  });
  assert.equal(started.minerId, 2);
  assert.equal(calls[0].args[0].minerId, 2n);
});

test('a lost begin-run response recovers the matching on-chain Miner lock without a second transaction', async () => {
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  const service = new NftGameplayService({
    enabled: true,
    chainId: 2020,
    rpcUrl: 'https://example.invalid',
    settlementAddress: SETTLEMENT,
    loadoutAddress: LOADOUT,
    operatorAddress: operator.address,
    signerAddress: signer.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    mapVersions: { arena: MAP_VERSION, paid: MAP_VERSION },
    metadataService: { async minerProfile() { return profile(); } },
    publicClient: fakePublicClient(),
    operatorClient: {
      async writeContract() {
        throw new Error('RPC response lost after broadcast');
      }
    }
  });
  const started = await service.beginRun({
    address: PLAYER,
    minerId: 1,
    mode: 'paid',
    authorization: authorization(1),
    playerSignature: PLAYER_SIGNATURE
  });
  assert.equal(started.runId, RUN_ID);
  assert.equal(started.recovered, true);
  assert.equal(started.beginTransactionHash, null);
});

test('NFT crystal pickups stop at the active backpack capacity and results carry exact phase state', () => {
  const game = new MattMineGame({ getContext() {} }, defaultProfile(), { headless: true });
  let result;
  game.hooks.onRunEnd = (value) => { result = value; };
  game.startRun({ mode: 'free', seed: 'NFT-CAPACITY', tuning: { nftCrystalCarryLimit: 2 } });
  game.run.crystalsCollected = 2;
  game.run.crystals = 2;
  game.run.depth = 3;
  game.endRun(true);
  assert.equal(result.crystalsCarried, 2);
  assert.equal(result.completedPhases, 0x07);
  assert.equal(completedPhaseCount(result), 3);
});

test('NFT armor health overrides legacy character and permanent-health bonuses exactly', () => {
  const boosted = defaultProfile();
  boosted.meta.health = 10;
  const game = new MattMineGame({ getContext() {} }, boosted, { headless: true });
  game.startRun({
    mode: 'practice',
    seed: 'NFT-ARMOR-HEALTH',
    nftRun: { minerId: 1 },
    character: { baseHealth: 200 },
    tuning: { playerMaxHealth: 175 }
  });
  assert.equal(game.player.maxHealth, 175);
  assert.equal(game.player.health, 175);
});

test('NFT level pacing targets six months at twenty perfect runs per day', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../contracts/src/nftv2/libraries/MattV2Math.sol', import.meta.url), 'utf8'));
  assert.match(source, /LEVEL_100_XP = 360_000/);
  assert.equal(Math.ceil(360_000 / (100 * 20)), 180);
});

test('a lost settlement HTTP response retries idempotently against processedRuns', async () => {
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  const service = new NftGameplayService({
    enabled: true,
    chainId: 2020,
    rpcUrl: 'https://example.invalid',
    settlementAddress: SETTLEMENT,
    loadoutAddress: LOADOUT,
    operatorAddress: operator.address,
    signerAddress: signer.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    mapVersions: { arena: MAP_VERSION, paid: MAP_VERSION },
    metadataService: { async minerProfile() { return profile(); } },
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === 'activeRun') return [
          `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`, `0x${'00'.repeat(32)}`,
          '0x0000000000000000000000000000000000000000', 0n, 0n, 0n, 0, 0, 0, 0, 0n
        ];
        if (functionName === 'processedRuns') return true;
        throw new Error(`Unexpected ${functionName}`);
      }
    },
    operatorClient: { async writeContract() { throw new Error('must not broadcast'); } }
  });
  const result = await service.settleRun({
    address: PLAYER,
    minerId: 1,
    runId: RUN_ID,
    result: { extracted: true, crystalsCarried: 10 },
    completedPhases: 5
  });
  assert.equal(result.alreadySettled, true);
  assert.equal(result.transactionHash, null);
});

test('verified NFT settlement banks crystals once and removes the legacy Practice nugget claim', () => {
  const wallet = {
    address: PLAYER.toLowerCase(),
    nftCrystalBalance: 7,
    nftCrystalLedger: [],
    practiceClaims: { run_abc: { status: 'pending', projectedNuggets: 999 } }
  };
  const settlement = {
    address: PLAYER,
    runId: 'run_abc',
    amount: 12,
    transactionHash: `0x${'34'.repeat(32)}`,
    timestamp: 123
  };
  assert.equal(recordNftCrystalBank(wallet, settlement), true);
  assert.equal(recordNftCrystalBank(wallet, settlement), false);
  assert.equal(wallet.nftCrystalBalance, 19);
  assert.equal(wallet.nftCrystalLedger.length, 1);
  assert.equal(wallet.nftCrystalLedger[0].amount, 12);
  assert.equal(wallet.practiceClaims.run_abc, undefined);
});
