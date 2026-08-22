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
import { RoninWalletAdapter } from '../src/game/walletAdapter.js';
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

function healthPublicClient(operatorAddress, signerAddress, operatorBalance) {
  return {
    async getChainId() { return 2020; },
    async getBalance({ address }) {
      return address.toLowerCase() === operatorAddress.toLowerCase()
        ? operatorBalance
        : 10n ** 18n;
    },
    async readContract({ functionName }) {
      if (functionName === 'OPERATOR_ROLE') return `0x${'55'.repeat(32)}`;
      if (functionName === 'paused') return false;
      if (functionName === 'rewardSigner') return signerAddress;
      if (functionName === 'hasRole') return true;
      if (functionName === 'mapVersions') return [
        `0x${'01'.repeat(32)}`,
        `0x${'02'.repeat(32)}`,
        10n ** 18n,
        500n * 10n ** 18n,
        2_500,
        7_200,
        true,
        false
      ];
      throw new Error(`Unexpected ${functionName}`);
    }
  };
}

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

test('NFT gameplay exposes normalized active-map state and a secret-free chain health snapshot', async () => {
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  const publicClient = {
    async getChainId() { return 2020; },
    async getBalance({ address }) { return address === operator.address ? 5n * 10n ** 18n : 7n * 10n ** 18n; },
    async readContract({ functionName }) {
      if (functionName === 'OPERATOR_ROLE') return `0x${'55'.repeat(32)}`;
      if (functionName === 'paused') return false;
      if (functionName === 'rewardSigner') return signer.address;
      if (functionName === 'hasRole') return true;
      if (functionName === 'mapVersions') return [
        `0x${'01'.repeat(32)}`,
        `0x${'02'.repeat(32)}`,
        10n ** 18n,
        500n * 10n ** 18n,
        2_500,
        7_200,
        true,
        false
      ];
      throw new Error(`Unexpected ${functionName}`);
    }
  };
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
    publicClient,
    operatorClient: {}
  });

  const active = await service.activeMap('pass');
  assert.deepEqual(active, {
    mode: 'paid',
    versionId: MAP_VERSION,
    mapId: `0x${'01'.repeat(32)}`,
    contentHash: `0x${'02'.repeat(32)}`,
    conversionRateRaw: (10n ** 18n).toString(),
    maximumPayoutRaw: (500n * 10n ** 18n).toString(),
    mineableCrystalUnits: 2_500,
    runTimeoutSeconds: 7_200,
    approved: true,
    retired: false
  });
  const health = await service.health();
  assert.equal(health.ok, true);
  assert.equal(health.settlement.paused, false);
  assert.equal(health.operator.authorized, true);
  assert.equal(health.operator.funded, true);
  assert.equal(health.routesConfigured, true);
  assert.equal(health.rewardSigner.matches, true);
  assert.equal(health.activeMaps.paid.contentHash, active.contentHash);
  assert.deepEqual(health.nativeBalancesRaw, {
    operator: (5n * 10n ** 18n).toString(),
    rewardSigner: (7n * 10n ** 18n).toString()
  });
  assert.equal('rpcUrl' in health, false);
});

test('NFT gameplay readiness fails closed when the transaction operator is below its gas floor', async () => {
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
    publicClient: healthPublicClient(operator.address, signer.address, 1n),
    operatorClient: {}
  });

  const health = await service.health();
  assert.equal(health.ok, false);
  assert.equal(health.operator.funded, false);
  assert.equal(health.operator.minimumBalanceRaw, (20_000_000_000_000_000n).toString());
});

test('NFT gameplay readiness requires both Arena and Pass Mine routes', async () => {
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
    publicClient: healthPublicClient(operator.address, signer.address, 10n ** 18n),
    operatorClient: {}
  });
  service.clearMapVersion('paid');

  const health = await service.health();
  assert.equal(health.ok, false);
  assert.equal(health.routesConfigured, false);
  assert.deepEqual(health.requiredRoutes, ['arena', 'paid']);
});

test('Miner run approvals include the explicit EIP-712 domain type required by Ronin Wallet', async () => {
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
        if (functionName === 'playerNonces') return 0n;
        if (functionName === 'loadoutHash') return LOADOUT_HASH;
        if (functionName === 'mapVersions') {
          return [MAP_VERSION, MAP_VERSION, 1n, 1n, 1, 300, true, false];
        }
        throw new Error(`Unexpected ${functionName}`);
      }
    },
    operatorClient: {}
  });
  const prepared = await service.prepareRunAuthorization({ address: PLAYER, minerId: 1, mode: 'paid' });
  assert.deepEqual(prepared.typedData.types.EIP712Domain, [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' }
  ]);
});

test('the Ronin adapter repairs cached run approvals that omit the EIP-712 domain type', async () => {
  const requests = [];
  const adapter = new RoninWalletAdapter({ api: {} });
  adapter.player = { address: PLAYER };
  adapter.provider = {
    async request(payload) {
      requests.push(payload);
      if (payload.method === 'eth_requestAccounts') return [PLAYER];
      if (payload.method === 'eth_chainId') return '0x7e4';
      if (payload.method === 'eth_signTypedData_v4') return PLAYER_SIGNATURE;
      throw new Error(`Unexpected ${payload.method}`);
    }
  };
  await adapter.signNftRunAuthorization({
    authorization: authorization(1),
    typedData: {
      domain: {
        name: 'MATT Mine V2 Run Settlement',
        version: '2',
        chainId: 2020,
        verifyingContract: SETTLEMENT
      },
      types: {
        RunAuthorization: [
          { name: 'player', type: 'address' },
          { name: 'minerId', type: 'uint256' },
          { name: 'mapVersion', type: 'bytes32' },
          { name: 'loadoutHash', type: 'bytes32' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' }
        ]
      },
      primaryType: 'RunAuthorization',
      message: authorization(1)
    }
  });
  const request = requests.find(({ method }) => method === 'eth_signTypedData_v4');
  const signedPayload = JSON.parse(request.params[1]);
  assert.equal(signedPayload.types.EIP712Domain[3].name, 'verifyingContract');
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

function fakePublicClient(minerId = 1, options = {}) {
  return {
    async readContract(call) {
      if (call.functionName === 'playerNonces') return 0n;
      if (call.functionName === 'loadoutHash') return LOADOUT_HASH;
      if (call.functionName === 'activeRun') return [
        RUN_ID, MAP_VERSION, LOADOUT_HASH, PLAYER, 10n ** 16n, 100_000n * 10n ** 18n,
        1n, options.mineableCrystalUnits ?? 1_000_000, options.runTimeoutSeconds ?? 7_200,
        options.carryCapacity ?? 1_500, 1_000, 0n
      ];
      if (call.functionName === 'phaseXpForMap' && options.phaseXp) return options.phaseXp.map(BigInt);
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
  assert.equal(started.mineableCrystalUnits, 1_000_000);
  assert.equal(started.runTimeoutSeconds, 7_200);
  assert.deepEqual(started.phaseXp, [10, 15, 20, 25, 30]);
  assert.equal(calls[0].functionName, 'beginRun');
  assert.equal(calls[0].args[0].minerId, 1n);
  assert.equal(calls[0].args[1], PLAYER_SIGNATURE);
});

test('NFT gameplay applies the lower onchain map cap when it is below backpack capacity', async () => {
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
    publicClient: fakePublicClient(1, { mineableCrystalUnits: 25, phaseXp: [20, 30, 40, 50, 60] }),
    operatorClient: { async writeContract() { return `0x${'12'.repeat(32)}`; } }
  });
  const started = await service.beginRun({
    address: PLAYER,
    minerId: 1,
    mode: 'paid',
    authorization: authorization(1),
    playerSignature: PLAYER_SIGNATURE
  });
  assert.equal(started.crystalCarryLimit, 25);
  assert.equal(started.mapEconomy.carryCapacity, 1_500);
  assert.equal(started.mapEconomy.mineableCrystalUnits, 25);
  assert.deepEqual(started.phaseXp, [20, 30, 40, 50, 60]);
  assert.equal(started.forceAbandonAt, 7_201);
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

test('NFT armor health overrides the browser character health exactly', () => {
  const game = new MattMineGame({ getContext() {} }, defaultProfile(), { headless: true });
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

test('NFT settlement rejects mined Crystal units above the active onchain map cap before broadcast', async () => {
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  let broadcasts = 0;
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
          RUN_ID, MAP_VERSION, LOADOUT_HASH, PLAYER, 10n ** 16n, 100_000n * 10n ** 18n,
          1n, 5, 7_200, 1_500, 1_000, 0n
        ];
        if (functionName === 'processedRuns') return false;
        throw new Error(`Unexpected ${functionName}`);
      }
    },
    operatorClient: { async writeContract() { broadcasts += 1; return `0x${'12'.repeat(32)}`; } }
  });

  await assert.rejects(() => service.settleRun({
    address: PLAYER,
    minerId: 1,
    runId: RUN_ID,
    result: { extracted: true, crystalsCarried: 6 },
    completedPhases: 1
  }), { code: 'nft_mineable_crystal_limit' });
  assert.equal(broadcasts, 0);
});

test('NFT settlement reports configured phase XP and verifies the observed banked-XP delta', async () => {
  const operator = privateKeyToAccount(OPERATOR_KEY);
  const signer = privateKeyToAccount(SIGNER_KEY);
  let profileReads = 0;
  const metadataService = {
    async minerProfile() {
      profileReads += 1;
      const current = profile();
      current.progression.bankedXp = profileReads === 1 ? 100 : 190;
      return current;
    }
  };
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
    metadataService,
    publicClient: {
      async readContract({ functionName }) {
        if (functionName === 'activeRun') return [
          RUN_ID, MAP_VERSION, LOADOUT_HASH, PLAYER, 10n ** 16n, 100_000n * 10n ** 18n,
          1n, 1_000, 7_200, 1_500, 1_000, 0n
        ];
        if (functionName === 'processedRuns') return false;
        if (functionName === 'phaseXpForMap') return [20n, 30n, 40n, 50n, 60n];
        throw new Error(`Unexpected ${functionName}`);
      },
      async waitForTransactionReceipt() { return { status: 'success' }; }
    },
    operatorClient: { async writeContract() { return `0x${'12'.repeat(32)}`; } }
  });

  const settled = await service.settleRun({
    address: PLAYER,
    minerId: 1,
    runId: RUN_ID,
    result: { extracted: true, crystalsCarried: 10 },
    completedPhases: 3
  });
  assert.equal(settled.xpBanked, 90);
  assert.equal(settled.configuredXpBanked, 90);
  assert.equal(settled.xpParityVerified, true);
  assert.deepEqual(settled.phaseXp, [20, 30, 40, 50, 60]);
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

test('verified NFT settlement banks crystals exactly once', () => {
  const wallet = {
    address: PLAYER.toLowerCase(),
    nftCrystalBalance: 7,
    nftCrystalLedger: []
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
});
