import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { ApiError } from '../server/errors.js';
import { createMattMineHttpServer } from '../server/http.js';
import { NftMetadataService, ViemNftChainReader } from '../server/nft-metadata-service.js';
import { MattMineApiClient } from '../src/game/apiClient.js';
import { NftGarageClient } from '../src/game/nftGarageClient.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OWNER = '0x1DAb596D0121C250a24B00137E84170FA6874be6';
const OTHER = '0x0000000000000000000000000000000000000001';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESSES = Object.freeze({
  miner: '0x545d5d4c714eB4d2242BBFE82C31fe9a1E5Cff29',
  equipment: '0x73A4Ad9a2b4bfeeE1b98F5D99AaB24B702dEb093',
  loadout: '0x6cf168cdD198D0d111faE2286aE6dcD86FA960d8'
});

function transfer(tokenId, from, to, blockNumber, logIndex = 0) {
  return {
    blockNumber: BigInt(blockNumber),
    transactionIndex: 0,
    logIndex,
    args: { tokenId: BigInt(tokenId), from, to }
  };
}

function assignment(tokenId, minerId, blockNumber, logIndex = 0) {
  return {
    blockNumber: BigInt(blockNumber),
    transactionIndex: 0,
    logIndex,
    args: { tokenId: BigInt(tokenId), minerId: BigInt(minerId) }
  };
}

function indexedClient(options = {}) {
  const state = {
    currentBlock: BigInt(options.currentBlock ?? 100),
    minerTransfers: [...(options.minerTransfers || [])],
    equipmentTransfers: [...(options.equipmentTransfers || options.transfers || [])],
    assignments: [...(options.assignments || [])],
    blockHashes: new Map(Object.entries(options.blockHashes || {}).map(([block, hash]) => [BigInt(block), hash])),
    balanceBarrier: null,
    blockCalls: 0,
    blockHashCalls: [],
    logCalls: [],
    multicallCalls: []
  };
  const logsInRange = (logs, fromBlock, toBlock) => logs.filter((log) =>
    log.blockNumber >= fromBlock && log.blockNumber <= toBlock
  );
  const ownersAt = (transfers, blockNumber) => {
    const owners = new Map();
    for (const log of [...transfers]
      .filter((entry) => entry.blockNumber <= blockNumber)
      .sort((left, right) => Number(left.blockNumber - right.blockNumber) || left.logIndex - right.logIndex)) {
      const tokenId = Number(log.args.tokenId);
      if (String(log.args.to).toLowerCase() === ZERO) owners.delete(tokenId);
      else owners.set(tokenId, String(log.args.to).toLowerCase());
    }
    return owners;
  };
  const balanceAt = (transfers, owner, blockNumber) => {
    return [...ownersAt(transfers, blockNumber).values()]
      .filter((value) => value === String(owner).toLowerCase()).length;
  };
  const nextTokenId = (transfers, override) => {
    if (override !== undefined) return BigInt(override);
    return BigInt(Math.max(0, ...transfers.map((log) => Number(log.args.tokenId))) + 1);
  };
  const assignmentAt = (tokenId, blockNumber) => {
    let minerId = 0n;
    for (const log of [...state.assignments]
      .filter((entry) => entry.blockNumber <= blockNumber && Number(entry.args.tokenId) === tokenId)
      .sort((left, right) => Number(left.blockNumber - right.blockNumber) || left.logIndex - right.logIndex)) {
      minerId = BigInt(log.args.minerId);
    }
    return minerId;
  };
  const client = {
    async getBlockNumber() {
      state.blockCalls += 1;
      if (options.blockDelay) await options.blockDelay();
      return state.currentBlock;
    },
    async getBlock({ blockNumber }) {
      const block = BigInt(blockNumber);
      state.blockHashCalls.push(block);
      return {
        number: block,
        hash: options.blockHash?.(block, state.blockHashCalls.length) ||
          state.blockHashes.get(block) ||
          `0x${block.toString(16).padStart(64, '0')}`
      };
    },
    async getLogs({ address, event, fromBlock, toBlock }) {
      state.logCalls.push({ address, name: event.name, fromBlock, toBlock });
      const normalizedAddress = String(address).toLowerCase();
      const logs = event.name !== 'Transfer'
        ? state.assignments
        : normalizedAddress === ADDRESSES.miner.toLowerCase()
          ? state.minerTransfers
          : state.equipmentTransfers;
      return logsInRange(logs, fromBlock, toBlock);
    },
    async readContract({ address, functionName, args, blockNumber }) {
      const isMiner = String(address).toLowerCase() === ADDRESSES.miner.toLowerCase();
      if (functionName === 'nextTokenId') {
        return isMiner
          ? nextTokenId(state.minerTransfers, options.nextMinerTokenId)
          : nextTokenId(state.equipmentTransfers, options.nextEquipmentTokenId);
      }
      assert.equal(functionName, 'balanceOf');
      if (state.balanceBarrier) await state.balanceBarrier();
      const transfers = isMiner ? state.minerTransfers : state.equipmentTransfers;
      return BigInt(balanceAt(transfers, args[0], BigInt(blockNumber)));
    },
    async multicall({ contracts, allowFailure, blockNumber }) {
      assert.equal(allowFailure, true);
      const pinnedBlock = BigInt(blockNumber);
      state.multicallCalls.push({ contracts, blockNumber: pinnedBlock });
      return contracts.map((contract) => {
        const isMiner = String(contract.address).toLowerCase() === ADDRESSES.miner.toLowerCase();
        const tokenId = Number(contract.args[0]);
        const transfers = isMiner ? state.minerTransfers : state.equipmentTransfers;
        const owner = ownersAt(transfers, pinnedBlock).get(tokenId);
        if (!owner) return { status: 'failure', error: new Error('ERC721 nonexistent token') };
        if (contract.functionName === 'ownerOf') return { status: 'success', result: owner };
        assert.equal(contract.functionName, 'equipmentData');
        return {
          status: 'success',
          result: {
            definitionId: 1000,
            equippedToMiner: assignmentAt(tokenId, pinnedBlock),
            slot: 0,
            rarity: 0,
            damaged: false
          }
        };
      });
    }
  };
  return { client, state };
}

function indexReader(client, options = {}) {
  return new ViemNftChainReader({
    chainId: 2020,
    rpcUrl: 'https://example.invalid',
    addresses: ADDRESSES,
    minerDeploymentBlock: 100,
    equipmentDeploymentBlock: 100,
    equipmentIndexChunkSize: options.chunkSize ?? 100,
    equipmentIndexRefreshMs: options.refreshMs ?? 0,
    equipmentIndexConfirmations: options.confirmations ?? 0,
    equipmentIndexMaxChunks: options.maxChunks ?? 25,
    client
  });
}

test('Equipment Transfer indexing applies outgoing transfers, burns, and incremental blocks', async () => {
  const indexed = indexedClient({
    currentBlock: 104,
    transfers: [
      transfer(1, ZERO, OWNER, 100),
      transfer(2, ZERO, OWNER, 101),
      transfer(3, ZERO, OWNER, 102),
      transfer(2, OWNER, OTHER, 103),
      transfer(3, OWNER, ZERO, 104)
    ]
  });
  const reader = indexReader(indexed.client, { chunkSize: 2 });

  assert.deepEqual((await reader.equipmentTokenPageForOwner(OWNER)).tokenIds, [1]);
  assert.equal(indexed.state.logCalls.length, 9);

  indexed.state.equipmentTransfers.push(transfer(4, ZERO, OWNER, 105));
  indexed.state.currentBlock = 105n;
  assert.deepEqual((await reader.equipmentTokenPageForOwner(OWNER)).tokenIds, [1, 4]);
  assert.deepEqual(indexed.state.logCalls.slice(-3).map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [
    [105n, 105n],
    [105n, 105n],
    [105n, 105n]
  ]);
});

test('Equipment inventory pagination is token-ordered, bounded, and pinned to an indexed block', async () => {
  const indexed = indexedClient({
    transfers: [
      transfer(5, ZERO, OWNER, 100, 0),
      transfer(1, ZERO, OWNER, 100, 1),
      transfer(3, ZERO, OWNER, 100, 2)
    ]
  });
  const reader = indexReader(indexed.client, { refreshMs: 60_000 });

  const first = await reader.equipmentTokenPageForOwner(OWNER, { limit: 2 });
  assert.deepEqual(first.tokenIds, [1, 3]);
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);
  const second = await reader.equipmentTokenPageForOwner(OWNER, { limit: 2, cursor: first.nextCursor });
  assert.deepEqual(second.tokenIds, [5]);
  assert.equal(second.nextCursor, '');
  await assert.rejects(
    () => reader.equipmentTokenPageForOwner(OWNER, { limit: 101 }),
    (error) => error.status === 400 && error.code === 'nft_equipment_page_too_large'
  );

  indexed.state.currentBlock = 101n;
  reader.equipmentIndexRefreshMs = 0;
  indexed.state.equipmentTransfers.push(transfer(7, ZERO, OWNER, 101));
  await reader.equipmentTokenPageForOwner(OWNER, { limit: 1 });
  await assert.rejects(
    () => reader.equipmentTokenPageForOwner(OWNER, { limit: 2, cursor: first.nextCursor }),
    (error) => error.status === 409 && error.code === 'nft_equipment_inventory_changed'
  );
});

test('Loadout-custodied Equipment follows the server-verified Miner owner and burned backpacks disappear', async () => {
  const indexed = indexedClient({
    currentBlock: 101,
    minerTransfers: [
      transfer(7, ZERO, OWNER, 100, 0),
      transfer(8, ZERO, OTHER, 100, 1)
    ],
    transfers: [
      transfer(10, ZERO, OWNER, 100, 0),
      transfer(10, OWNER, ADDRESSES.loadout, 101, 0),
      transfer(11, ZERO, ADDRESSES.loadout, 101, 2)
    ],
    assignments: [
      assignment(10, 7, 101, 1),
      assignment(11, 8, 101, 3)
    ]
  });
  const reader = indexReader(indexed.client);

  assert.deepEqual((await reader.equipmentTokenPageForOwner(OWNER)).tokenIds, [10]);
  assert.deepEqual((await reader.equipmentTokenPageForOwner(OTHER)).tokenIds, [11]);

  indexed.state.equipmentTransfers.push(transfer(10, ADDRESSES.loadout, ZERO, 102));
  indexed.state.currentBlock = 102n;
  assert.deepEqual((await reader.equipmentTokenPageForOwner(OWNER)).tokenIds, []);
});

test('concurrent Equipment inventory requests coalesce one chain-log refresh', async () => {
  const indexed = indexedClient({
    transfers: [transfer(1, ZERO, OWNER, 100)],
    blockDelay: () => new Promise((resolve) => setTimeout(resolve, 10))
  });
  const reader = indexReader(indexed.client, { refreshMs: 5_000 });
  const [left, right] = await Promise.all([
    reader.equipmentTokenPageForOwner(OWNER),
    reader.equipmentTokenPageForOwner(OWNER)
  ]);
  assert.deepEqual(left.tokenIds, [1]);
  assert.deepEqual(right.tokenIds, [1]);
  assert.equal(indexed.state.blockCalls, 1);
  assert.equal(indexed.state.logCalls.length, 3);
});

test('Equipment ownership index reads only confirmed blocks and advances when they finalize', async () => {
  const indexed = indexedClient({
    currentBlock: 112,
    transfers: [
      transfer(1, ZERO, OWNER, 100),
      transfer(2, ZERO, OWNER, 105)
    ]
  });
  const reader = indexReader(indexed.client, { confirmations: 12 });

  const first = await reader.equipmentInventorySnapshotForOwner(OWNER);
  assert.deepEqual(first.tokenIds, [1]);
  assert.equal(first.indexedToBlock, '100');
  assert.equal(reader.inventoryIndexStatus().confirmedBlock, '100');

  indexed.state.currentBlock = 117n;
  const second = await reader.equipmentInventorySnapshotForOwner(OWNER);
  assert.deepEqual(second.tokenIds, [1, 2]);
  assert.equal(second.indexedToBlock, '105');
  assert.equal(reader.inventoryIndexStatus().confirmedBlock, '105');
});

test('Equipment ownership index warms in bounded slices before reporting ready', async () => {
  const indexed = indexedClient({ currentBlock: 100 });
  const reader = indexReader(indexed.client, { chunkSize: 1, maxChunks: 2 });

  await reader.syncEquipmentOwnershipIndex();
  indexed.state.currentBlock = 105n;

  await reader.syncEquipmentOwnershipIndex();
  assert.deepEqual(reader.inventoryIndexStatus(), {
    ready: false,
    warming: false,
    confirmations: 0,
    indexedToBlock: '102',
    confirmedBlock: '105',
    remainingBlocks: '3'
  });

  await reader.prewarmEquipmentIndex();
  assert.equal(reader.inventoryIndexStatus().ready, true);
  assert.equal(reader.inventoryIndexStatus().indexedToBlock, '105');
  assert.equal(reader.inventoryIndexStatus().remainingBlocks, '0');
});

test('cold Equipment index bootstraps confirmed state beyond replay capacity and then consumes incremental logs', async () => {
  const indexed = indexedClient({
    currentBlock: 130,
    nextEquipmentTokenId: 5,
    minerTransfers: [
      ...Array.from({ length: 6 }, (_value, index) => transfer(index + 1, ZERO, OTHER, 100, index)),
      transfer(7, ZERO, OWNER, 101),
      transfer(8, ZERO, OTHER, 102)
    ],
    transfers: [
      transfer(1, ZERO, OWNER, 101),
      transfer(2, ZERO, OWNER, 102),
      transfer(2, OWNER, ADDRESSES.loadout, 105),
      transfer(3, ZERO, OWNER, 103),
      transfer(3, OWNER, ZERO, 110)
    ],
    assignments: [assignment(2, 7, 105)]
  });
  const reader = indexReader(indexed.client, { chunkSize: 2, maxChunks: 2 });

  const bootstrapped = await reader.equipmentInventorySnapshotForOwner(OWNER);
  assert.deepEqual(bootstrapped.directTokenIds, [1]);
  assert.deepEqual(bootstrapped.custodyTokenIds, [2]);
  assert.deepEqual(bootstrapped.tokenIds, [1, 2]);
  assert.equal(bootstrapped.indexedToBlock, '130');
  assert.equal(indexed.state.logCalls.length, 0, 'cold start must not replay historical logs');
  assert.equal(indexed.state.multicallCalls.length, 11, '1,000 Miners plus four Equipment IDs use fixed batches');
  assert.ok(indexed.state.multicallCalls.every(({ blockNumber }) => blockNumber === 130n));

  indexed.state.equipmentTransfers.push(
    transfer(1, OWNER, OTHER, 131, 0),
    transfer(5, ZERO, OWNER, 131, 1)
  );
  indexed.state.currentBlock = 131n;
  const incremented = await reader.equipmentInventorySnapshotForOwner(OWNER);
  assert.deepEqual(incremented.tokenIds, [2, 5]);
  assert.equal(incremented.indexedToBlock, '131');
  assert.deepEqual(indexed.state.logCalls.map(({ fromBlock, toBlock }) => [fromBlock, toBlock]), [
    [131n, 131n],
    [131n, 131n],
    [131n, 131n]
  ]);
});

test('cold Equipment bootstrap never commits state across a confirmed-block hash change', async () => {
  const indexed = indexedClient({
    currentBlock: 130,
    minerTransfers: [
      ...Array.from({ length: 6 }, (_value, index) => transfer(index + 1, ZERO, OTHER, 100, index)),
      transfer(7, ZERO, OWNER, 101)
    ],
    transfers: [transfer(1, ZERO, OWNER, 101)],
    blockHash: (_block, call) => `0x${(call === 1 ? 'a' : 'b').repeat(64)}`
  });
  const reader = indexReader(indexed.client, { chunkSize: 2, maxChunks: 2 });

  await assert.rejects(
    () => reader.syncEquipmentOwnershipIndex(),
    (error) => error.status === 503 && error.code === 'nft_equipment_index_bootstrap_reorg'
  );
  assert.equal(reader.inventoryIndexStatus().ready, false);
  assert.equal(reader.inventoryIndexStatus().indexedToBlock, '99');
  assert.equal(indexed.state.logCalls.length, 0);
});

test('Equipment snapshot detects an index advance while pinned balances are being read', async () => {
  const indexed = indexedClient({
    currentBlock: 100,
    transfers: [transfer(1, ZERO, OWNER, 100)]
  });
  const reader = indexReader(indexed.client);
  assert.deepEqual((await reader.equipmentInventorySnapshotForOwner(OWNER)).tokenIds, [1]);

  let releaseBalances;
  let reportBalanceRead;
  const balancesReleased = new Promise((resolve) => { releaseBalances = resolve; });
  const balanceRead = new Promise((resolve) => { reportBalanceRead = resolve; });
  indexed.state.balanceBarrier = async () => {
    reportBalanceRead();
    await balancesReleased;
  };
  const pendingSnapshot = reader.equipmentInventorySnapshotForOwner(OWNER);
  await balanceRead;

  indexed.state.equipmentTransfers.push(transfer(2, ZERO, OWNER, 101));
  indexed.state.currentBlock = 101n;
  await reader.syncEquipmentOwnershipIndex({ force: true });
  releaseBalances();

  await assert.rejects(
    () => pendingSnapshot,
    (error) => error.status === 409 && error.code === 'nft_equipment_inventory_changed'
  );
  indexed.state.balanceBarrier = null;
});

test('Equipment checkpoint rejects stale snapshots and rebuilds after a confirmed reorg', async () => {
  const indexed = indexedClient({
    currentBlock: 100,
    transfers: [transfer(1, ZERO, OWNER, 100)]
  });
  const reader = indexReader(indexed.client);
  const before = await reader.equipmentInventorySnapshotForOwner(OWNER);
  assert.deepEqual(before.tokenIds, [1]);

  indexed.state.blockHashes.set(100n, `0x${'f'.repeat(64)}`);
  await assert.rejects(
    () => reader.assertEquipmentInventorySnapshot(before),
    (error) => error.status === 409 && error.code === 'nft_equipment_inventory_changed'
  );

  indexed.state.equipmentTransfers.splice(0, indexed.state.equipmentTransfers.length,
    transfer(2, ZERO, OWNER, 100));
  const after = await reader.equipmentInventorySnapshotForOwner(OWNER);
  assert.deepEqual(after.tokenIds, [2]);
  assert.notEqual(after.checkpointHash, before.checkpointHash);
});

test('metadata startup bounds index warm-up and reports not ready until the confirmed index catches up', async () => {
  const neverReady = new Promise(() => {});
  const service = new NftMetadataService({
    enabled: true,
    root: ROOT,
    publicOrigin: 'https://mattmine.com',
    chainId: 2020,
    addresses: ADDRESSES,
    equipmentIndexStartupWaitMs: 5,
    chainReader: {
      prewarmEquipmentIndex() {
        return neverReady;
      },
      async health() {
        return { ok: true, chainId: 2020, nextMinerTokenId: 1001 };
      },
      inventoryIndexStatus() {
        return { ready: false, warming: true, indexedToBlock: '100', confirmedBlock: '120' };
      }
    }
  });

  const startedAt = Date.now();
  await service.init();
  assert.ok(Date.now() - startedAt < 200, 'startup should not wait for the entire historical index');
  const health = await service.health();
  assert.equal(health.ok, false);
  assert.equal(health.equipmentIndex.ready, false);
});

test('metadata inventory caches Miner ownership and immutable token order across cursor pages', async () => {
  let snapshotCalls = 0;
  let forbiddenMinerScans = 0;
  let sourceTokenIds = [10, 11];
  const service = await new NftMetadataService({
    enabled: true,
    root: ROOT,
    publicOrigin: 'https://mattmine.com',
    chainId: 2020,
    addresses: ADDRESSES,
    chainReader: {
      async minerIdsForOwner(owner) {
        forbiddenMinerScans += 1;
        throw new Error(`unexpected Miner scan for ${owner}`);
      },
      async equipmentInventorySnapshotForOwner(owner) {
        snapshotCalls += 1;
        assert.equal(owner, OWNER);
        return {
          tokenIds: [...sourceTokenIds],
          directTokenIds: [...sourceTokenIds],
          custodyTokenIds: [],
          ownedMinerIds: [7],
          indexedToBlock: '100',
          checkpointHash: `0x${'1'.repeat(64)}`
        };
      },
      async equipmentBatch(tokenIds, options) {
        assert.equal(options.blockNumber, 100n);
        return tokenIds.map((tokenId) => ({
          owner: OWNER,
          definitionId: 1102,
          equippedToMiner: 0,
          slot: 1,
          rarity: 2,
          damaged: false,
          bonus: 5,
          tokenUri: `https://mattmine.com/api/nft/v2/equipment/${tokenId}.json`
        }));
      },
      async assertEquipmentInventorySnapshot(snapshot) {
        assert.equal(snapshot.indexedToBlock, 100n);
        assert.equal(snapshot.checkpointHash, `0x${'1'.repeat(64)}`);
      }
    }
  }).init();

  const first = await service.playerEquipmentInventory(OWNER, { limit: 1 });
  assert.equal(first.items[0].metadata.name, 'Rare Crystal Fang Pickaxe #10');
  assert.match(first.nextCursor, /^[A-Za-z0-9_-]+$/);

  sourceTokenIds = [99];
  const second = await service.playerEquipmentInventory(OWNER, { limit: 1, cursor: first.nextCursor });
  assert.equal(second.items[0].metadata.name, 'Rare Crystal Fang Pickaxe #11');
  assert.equal(second.nextCursor, '');
  assert.equal(snapshotCalls, 1);
  assert.equal(forbiddenMinerScans, 0);
});

test('authenticated same-origin Equipment endpoint binds pagination to the bearer session', async (context) => {
  const calls = [];
  const server = createMattMineHttpServer({
    root: ROOT,
    service: {
      publicOrigin: null,
      async equipmentInventory(token, options) {
        if (token !== 'session-token') throw new ApiError(401, 'session_required', 'Sign in required.');
        calls.push(options);
        return { owner: OWNER, items: [], nextCursor: '', total: 0, indexedToBlock: '100', pageSize: 25 };
      }
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  assert.equal((await fetch(`${origin}/api/me/equipment`)).status, 401);
  const response = await fetch(`${origin}/api/me/equipment?cursor=abc&limit=25`, {
    headers: { authorization: 'Bearer session-token' }
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).inventory.owner, OWNER);
  assert.deepEqual(calls, [{ cursor: 'abc', limit: '25', priorityTokenIds: '' }]);
});

test('Garage loads one bounded Equipment page and continues only after an explicit request', async () => {
  const requests = [];
  const garage = new NftGarageClient({
    wallet: { async sendPreparedTransaction() {} },
    api: {
      async equipmentInventory(cursor, limit, priorityTokenIds) {
        requests.push({ cursor, limit, priorityTokenIds });
        return cursor
          ? { owner: OWNER, items: [{ tokenId: 9 }], nextCursor: '', total: 2 }
          : { owner: OWNER, items: [{ tokenId: 3 }], nextCursor: 'page-two', total: 2 };
      }
    },
    fetch: async () => ({ ok: true, json: async () => ({}) })
  });
  const first = await garage.loadEquipment(OWNER, { priorityTokenIds: [88] });
  assert.deepEqual(first.items.map(({ tokenId }) => tokenId), [3]);
  assert.equal(first.nextCursor, 'page-two');
  assert.deepEqual(requests, [{ cursor: '', limit: 50, priorityTokenIds: [88] }]);

  const snapshot = await garage.loadMoreEquipment({
    address: OWNER,
    loadout: { armor: 88 },
    equipment: first.items,
    equipmentNextCursor: first.nextCursor,
    equipmentTotal: first.total
  });
  assert.deepEqual(snapshot.equipment.map(({ tokenId }) => tokenId), [3, 9]);
  assert.equal(snapshot.equipmentNextCursor, '');
  assert.deepEqual(requests, [
    { cursor: '', limit: 50, priorityTokenIds: [88] },
    { cursor: 'page-two', limit: 50, priorityTokenIds: [] }
  ]);

  const garageSource = await readFile(resolve(ROOT, 'src/game/nftGarageClient.js'), 'utf8');
  const garageLoader = garageSource.match(/async loadEquipment[\s\S]*?\n  async equip/)?.[0] || '';
  assert.match(garageLoader, /equipmentInventory/);
  assert.doesNotMatch(garageLoader, /nextTokenId|ownerOf|Array\.from|safe 10,000|pageNumber/);

  const labSource = await readFile(resolve(ROOT, 'src/nftLab.js'), 'utf8');
  const labLoader = labSource.match(/async function loadRelevantEquipment[\s\S]*?\nasync function fetchMetadata/)?.[0] || '';
  assert.match(labLoader, /equipmentInventory/);
  assert.doesNotMatch(labLoader, /nextTokenId|ownerOf|Array\.from|safe 10,000|pageNumber/);

  const [mainHtml, labHtml] = await Promise.all([
    readFile(resolve(ROOT, 'index.html'), 'utf8'),
    readFile(resolve(ROOT, 'nft-lab.html'), 'utf8')
  ]);
  assert.match(mainHtml, /id="garage-equipment-load-more"/);
  assert.match(labHtml, /id="equipment-load-more"/);
  assert.match(garageSource, /loadMoreEquipment/);
  assert.match(labSource, /loadMoreRelevantEquipment/);
});

test('Garage retries both Equipment index drift responses', async () => {
  for (const code of ['nft_equipment_inventory_changed', 'nft_equipment_index_changed']) {
    let requests = 0;
    const garage = new NftGarageClient({
      wallet: { async sendPreparedTransaction() {} },
      api: {
        async equipmentInventory() {
          requests += 1;
          if (requests === 1) throw Object.assign(new Error('refresh'), { code });
          return { owner: OWNER, items: [{ tokenId: 4 }], nextCursor: '', total: 1 };
        }
      },
      fetch: async () => ({ ok: true, json: async () => ({}) })
    });
    const page = await garage.loadEquipment(OWNER);
    assert.deepEqual(page.items.map(({ tokenId }) => tokenId), [4]);
    assert.equal(requests, 2);
  }
});

test('browser Equipment inventory requests stay same-origin and carry the wallet session', async () => {
  const requests = [];
  const client = new MattMineApiClient({
    storage: {
      getItem: () => 'session-token',
      setItem() {},
      removeItem() {}
    },
    fetch: async (url, options) => {
      requests.push({ url, authorization: options.headers.authorization });
      return new Response(JSON.stringify({
        ok: true,
        inventory: { owner: OWNER, items: [], nextCursor: '' }
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  await client.equipmentInventory('page-two', 25);
  assert.deepEqual(requests, [{
    url: '/api/me/equipment?limit=25&cursor=page-two',
    authorization: 'Bearer session-token'
  }]);
});
