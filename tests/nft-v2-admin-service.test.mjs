import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import {
  createNftV2AdminServiceFromEnvironment,
  NftV2AdminService
} from '../server/nft-v2-admin-service.js';

const KEY = `0x${createHash('sha256').update('matt-mine-v2-config-operator').digest('hex')}`;
const OPERATOR = privateKeyToAccount(KEY).address;
const ADDRESSES = {
  loadout: '0x1111111111111111111111111111111111111111',
  bank: '0x2222222222222222222222222222222222222222',
  chest: '0x3333333333333333333333333333333333333333',
  settlement: '0x4444444444444444444444444444444444444444'
};
const ROLE = `0x${'55'.repeat(32)}`;

test('production admin controls reuse the game-operator secret when the config alias is unset', () => {
  const service = createNftV2AdminServiceFromEnvironment({}, {
    MATT_MINE_NFT_ADMIN_CONTROLS_ENABLED: 'true',
    MATT_MINE_NFT_CHAIN_ID: '2020',
    MATT_MINE_NFT_RPC_URL: 'https://example.invalid',
    MATT_MINE_NFT_LOADOUT_ADDRESS: ADDRESSES.loadout,
    MATT_MINE_NFT_CRYSTAL_BANK_ADDRESS: ADDRESSES.bank,
    MATT_MINE_NFT_CHEST_ADDRESS: ADDRESSES.chest,
    MATT_MINE_NFT_SETTLEMENT_ADDRESS: ADDRESSES.settlement,
    MATT_MINE_NFT_CONFIG_OPERATOR_ADDRESS: OPERATOR,
    MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY: KEY
  });
  assert.ok(service instanceof NftV2AdminService);
});

function serviceHarness() {
  const writes = [];
  const mapVersions = { arena: `0x${'aa'.repeat(32)}`, paid: `0x${'bb'.repeat(32)}` };
  const gameplayService = {
    mapVersions,
    setMapVersion(mode, version) { this.mapVersions[mode] = version; },
    clearMapVersion(mode, version) { if (this.mapVersions[mode] === version) delete this.mapVersions[mode]; }
  };
  const publicClient = {
    async readContract({ functionName, args = [] }) {
      if (functionName === 'CONFIG_ROLE') return ROLE;
      if (functionName === 'hasRole') return true;
      if (functionName === 'paused') return true;
      if (functionName === 'repairPrice') return 500_000n * 10n ** 18n;
      if (functionName === 'minimumWithdrawal') return 1n * 10n ** 18n;
      if (functionName === 'walletDailyLimit') return 3_000_000n * 10n ** 18n;
      if (functionName === 'globalDailyLimit') return 10_000_000n * 10n ** 18n;
      if (functionName === 'chestPrice') return BigInt(Number(args[0]) + 1) * 10n ** 18n;
      if (functionName === 'phaseXpForMap') return [10n, 15n, 20n, 25n, 30n];
      throw new Error(`Unexpected read ${functionName}`);
    },
    async waitForTransactionReceipt() { return { status: 'success' }; }
  };
  const walletClient = {
    async writeContract(call) {
      writes.push(call);
      return `0x${String(writes.length).padStart(64, '0')}`;
    }
  };
  return {
    writes,
    gameplayService,
    service: new NftV2AdminService({
      enabled: true,
      chainId: 2020,
      rpcUrl: 'https://example.invalid',
      addresses: ADDRESSES,
      operatorAddress: OPERATOR,
      privateKey: KEY,
      gameplayService,
      publicClient,
      walletClient
    })
  };
}

test('NFT V2 Admin reads every live contract value and verifies CONFIG_ROLE', async () => {
  const { service } = serviceHarness();
  await service.init();
  const snapshot = await service.snapshot();
  assert.equal(snapshot.repairPriceRaw, (500_000n * 10n ** 18n).toString());
  assert.equal(snapshot.withdrawal.minimumRaw, (1n * 10n ** 18n).toString());
  assert.deepEqual(snapshot.paused, { loadout: true, bank: true, chest: true, settlement: true });
  assert.deepEqual(snapshot.activeMapVersions, { arena: `0x${'aa'.repeat(32)}`, paid: `0x${'bb'.repeat(32)}` });
  assert.deepEqual(snapshot.phaseXp.arena, [10, 15, 20, 25, 30]);
  assert.equal(snapshot.phaseXpConfigurable, true);
});

test('NFT V2 Admin controls five phase XP values independently for Arena and Pass Mine', async () => {
  const { service, writes, gameplayService } = serviceHarness();
  const result = await service.setPhaseXp({ mode: 'paid', phaseXp: [20, 30, 40, 50, 60] });
  assert.equal(result.versionId, gameplayService.mapVersions.paid);
  assert.deepEqual(result.phaseXp, [20, 30, 40, 50, 60]);
  assert.equal(writes.at(-1).functionName, 'setMapPhaseXp');
  assert.deepEqual(writes.at(-1).args, [gameplayService.mapVersions.paid, [20, 30, 40, 50, 60]]);
  await assert.rejects(() => service.setPhaseXp({ mode: 'paid', phaseXp: [100, 100, 100, 100, 101] }), { code: 'nft_phase_xp_invalid' });
});

test('NFT V2 Admin sends bounded economy writes and routes approved/retired maps immediately', async () => {
  const { service, writes, gameplayService } = serviceHarness();
  await service.setEconomy({
    repairPriceRaw: '10',
    withdrawal: { minimumRaw: (1n * 10n ** 18n).toString(), walletDailyRaw: (2n * 10n ** 18n).toString(), globalDailyRaw: (3n * 10n ** 18n).toString() },
    chestPrices: { armor: '4', backpack: '5' }
  });
  assert.deepEqual(writes.slice(0, 4).map(({ functionName }) => functionName), [
    'setRepairPrice', 'setWithdrawalConfiguration', 'setChestPrice', 'setChestPrice'
  ]);

  const approved = await service.approveMap({
    mode: 'arena',
    mapId: `0x${'01'.repeat(32)}`,
    contentHash: `0x${'02'.repeat(32)}`,
    mineableCrystalUnits: 1_000_000,
    conversionRateRaw: '10000000000000000',
    maximumPayoutRaw: '100000000000000000000000',
    runTimeoutSeconds: 7200
  });
  assert.equal(gameplayService.mapVersions.arena, approved.versionId);
  const retired = await service.retireMap({ versionId: approved.versionId });
  assert.deepEqual(retired.retiredModes, ['arena']);
  assert.equal(gameplayService.mapVersions.arena, undefined);
});

test('NFT V2 Admin rejects values above immutable map and withdrawal ceilings before writing', async () => {
  const { service, writes } = serviceHarness();
  await assert.rejects(() => service.setEconomy({}), { code: 'nft_economy_patch_empty' });
  await assert.rejects(() => service.approveMap({
    mode: 'paid', mapId: `0x${'01'.repeat(32)}`, contentHash: `0x${'02'.repeat(32)}`,
    mineableCrystalUnits: 1, conversionRateRaw: (100_001n * 10n ** 18n).toString(),
    maximumPayoutRaw: '1', runTimeoutSeconds: 300
  }), { code: 'nft_map_economy_invalid' });
  await assert.rejects(() => service.setEconomy({
    withdrawal: { minimumRaw: '1', walletDailyRaw: (1_000_001n * 10n ** 18n).toString(), globalDailyRaw: (1_000_001n * 10n ** 18n).toString() }
  }), { code: 'nft_withdrawal_limits_invalid' });
  assert.equal(writes.length, 0);
});
