import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';
import { SaigonChestKeeper, createSaigonChestKeeperFromEnvironment } from '../server/saigon-chest-keeper.js';

const PRIVATE_KEY = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const RANDOMNESS = '0x13B2CC4744657bbc75a1f7588A1Ca8e397E69521';
const CHEST = '0x52f66358ae951638a794777F3cc3448513d5be37';

function harness(consumers = new Map()) {
  const writes = [];
  const publicClient = {
    async getChainId() { return 202601; },
    async readContract(input) {
      if (input.functionName === 'oracle') return ACCOUNT.address;
      if (input.functionName === 'nextRequestId') return 4n;
      if (input.functionName === 'consumers') {
        return consumers.get(input.args[0]) || '0x0000000000000000000000000000000000000000';
      }
      throw new Error(`Unexpected read: ${input.functionName}`);
    },
    async waitForTransactionReceipt() { return { status: 'success' }; }
  };
  const walletClient = {
    async writeContract(input) {
      writes.push(input);
      consumers.delete(input.args[0]);
      return `0x${String(input.args[0]).padStart(64, '0')}`;
    }
  };
  const keeper = new SaigonChestKeeper({
    enabled: true,
    chainId: 202601,
    rpcUrl: 'https://saigon-testnet.roninchain.com/rpc',
    randomnessAddress: RANDOMNESS,
    chestAddress: CHEST,
    expectedOracle: ACCOUNT.address,
    privateKey: PRIVATE_KEY,
    pollIntervalMs: 60_000,
    publicClient,
    walletClient,
    logger: { info() {}, error() {} }
  });
  return { keeper, writes };
}

describe('Saigon chest keeper', () => {
  it('fulfills every pending chest request exactly once', async () => {
    const consumers = new Map([[1n, CHEST], [3n, CHEST]]);
    const { keeper, writes } = harness(consumers);
    await keeper.tick();
    assert.deepEqual(writes.map((write) => write.args[0]), [1n, 3n]);
    assert.equal(keeper.status().fulfilled, 2);
    assert.equal(keeper.status().pending, 0);
    await keeper.tick();
    assert.equal(writes.length, 2);
  });

  it('fails closed when a request belongs to another consumer', async () => {
    const { keeper, writes } = harness(new Map([[2n, '0x1111111111111111111111111111111111111111']]));
    await keeper.tick();
    assert.equal(writes.length, 0);
    assert.match(keeper.status().lastError, /unexpected consumer/);
  });

  it('stays disabled unless explicitly enabled with the dedicated key', () => {
    assert.equal(createSaigonChestKeeperFromEnvironment({}), null);
    assert.throws(
      () => createSaigonChestKeeperFromEnvironment({
        MATT_MINE_NFT_SAIGON_KEEPER_ENABLED: 'true',
        MATT_MINE_NFT_RANDOMNESS_ADDRESS: RANDOMNESS,
        MATT_MINE_NFT_CHEST_ADDRESS: CHEST,
        MATT_MINE_NFT_SAIGON_KEEPER_ADDRESS: ACCOUNT.address
      }),
      /private key is missing/
    );
  });
});
