import test from 'node:test';
import assert from 'node:assert/strict';

import {
  NftGarageClient,
  NFT_GARAGE_CONTRACTS,
  NFT_GARAGE_SELECTORS,
  formatTokenUnits,
  parseTokenUnits
} from '../src/game/nftGarageClient.js';
import { validatedNftLabRpcRequest } from '../server/http.js';

function garageHarness() {
  const calls = [];
  const garage = new NftGarageClient({
    wallet: { async sendPreparedTransaction() {} },
    fetch: async () => ({ ok: true, json: async () => ({ result: '0x' }) })
  });
  garage.send = async (to, data, kind) => calls.push({ to, data, kind });
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
});

test('Crystal withdrawal amounts round-trip without floating point loss', () => {
  const raw = parseTokenUnits('123.456789');
  assert.equal(raw, 123_456789_000000000000n);
  assert.equal(formatTokenUnits(raw, 18, 6), '123.456789');
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
