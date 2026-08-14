import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { nftRpcUrlFromEnvironment } from '../server/nft-rpc-url.js';

describe('NFT RPC configuration', () => {
  it('prefers the dedicated NFT RPC URL', () => {
    assert.equal(nftRpcUrlFromEnvironment({
      MATT_MINE_NFT_RPC_URL: 'https://dedicated.example/rpc',
      RONIN_RPC_URLS: 'https://shared.example/rpc'
    }), 'https://dedicated.example/rpc');
  });

  it('reuses the first production Alchemy/Ronin RPC when no dedicated URL is set', () => {
    assert.equal(nftRpcUrlFromEnvironment({
      RONIN_RPC_URLS: 'https://first.example/rpc, https://second.example/rpc'
    }), 'https://first.example/rpc');
  });

  it('rejects non-HTTPS RPC configuration', () => {
    assert.throws(
      () => nftRpcUrlFromEnvironment({ MATT_MINE_NFT_RPC_URL: 'http://localhost:8545' }),
      /must use HTTPS/
    );
  });
});
