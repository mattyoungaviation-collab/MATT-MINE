import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import { NftGameplayService } from '../server/nft-gameplay-service.js';
import { recordNftCrystalBank } from '../server/complete-production-service.js';
import { MattMineGame } from '../src/game/GameV4.js';
import { defaultProfile } from '../src/game/storage.js';

function testPrivateKey(label) {
  return `0x${createHash('sha256').update(`matt-mine-nft-test:${label}`).digest('hex')}`;
}

const OPERATOR_KEY = testPrivateKey('operator');
const SIGNER_KEY = testPrivateKey('signer');
const PLAYER = '0x1111111111111111111111111111111111111111';
const SETTLEMENT = '0x2222222222222222222222222222222222222222';

function profile(overrides = {}) {
  return {
    minerId: 1,
    owner: PLAYER,
    progression: { bankedXp: 0, level: 1, evolution: 0, prestigeXp: 0 },
    equipped: { weapon: 0, backpack: 9, helmet: 0, armor: 7, queuedBackpacks: 1 },
    gameplay: { maximumHealth: 175, crystalCarryMultiplier: 2, armorEffective: true, runLocked: false },
    render: { layout: 'matt-miner-fixed-v1', baseEvolution: 'rookie-miner', layers: [], damagedArmorFlashRed: false },
    ...overrides
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
    operatorAddress: operator.address,
    signerAddress: signer.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    baseCrystalCarryLimit: 10,
    metadataService,
    publicClient: {
      async waitForTransactionReceipt() { return { status: 'success' }; }
    },
    operatorClient: {
      async writeContract(call) { calls.push(call); return `0x${'12'.repeat(32)}`; }
    }
  });

  const started = await service.beginRun({ address: PLAYER, serverRunId: 'run_abc' });
  assert.equal(started.minerId, 1);
  assert.equal(started.profile.gameplay.maximumHealth, 175);
  assert.equal(started.crystalCarryLimit, 20);
  assert.equal(calls[0].functionName, 'beginRun');
  assert.deepEqual(calls[0].args, [1n]);
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
    operatorAddress: operator.address,
    signerAddress: signer.address,
    operatorPrivateKey: OPERATOR_KEY,
    signerPrivateKey: SIGNER_KEY,
    metadataService: {
      async minerProfile(id) {
        if (id === 2) return profile({ minerId: 2 });
        throw Object.assign(new Error('missing'), { status: 404 });
      }
    },
    publicClient: { async waitForTransactionReceipt() { return { status: 'success' }; } },
    operatorClient: { async writeContract(call) { calls.push(call); return `0x${'56'.repeat(32)}`; } }
  });

  const started = await service.beginRun({ address: PLAYER, serverRunId: 'run_selected', minerId: 2 });
  assert.equal(started.minerId, 2);
  assert.deepEqual(calls[0].args, [2n]);
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

test('NFT level pacing targets roughly 93 days at twenty maximum-XP runs per day', async () => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../server/nft-gameplay-service.js', import.meta.url), 'utf8'));
  assert.match(source, /Math\.floor\(safeXp \/ 1_500\)/);
  assert.equal(Math.ceil((99 * 1_500) / (80 * 20)), 93);
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
