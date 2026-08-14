import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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

  it('publishes role addresses while keeping every role key secret in Render', () => {
    const blueprint = readFileSync(new URL('../render.yaml', import.meta.url), 'utf8');
    assert.match(blueprint, /key: MATT_MINE_NFT_ENABLED\r?\n\s+value: "true"/);
    for (const [key, address] of [
      ['MATT_MINE_NFT_GAME_OPERATOR_ADDRESS', '0x112C8a89bfAb3f19D7ceADf7433Fd8D253cFe4D3'],
      ['MATT_MINE_NFT_REWARD_SIGNER_ADDRESS', '0x61FC35192964Fa4b50D915261419e9D2Ba369708'],
      ['MATT_MINE_NFT_CONFIG_OPERATOR_ADDRESS', '0x112C8a89bfAb3f19D7ceADf7433Fd8D253cFe4D3']
    ]) {
      assert.match(blueprint, new RegExp(`key: ${key}\\r?\\n\\s+value: "${address}"`));
    }
    for (const key of [
      'MATT_MINE_NFT_GAME_OPERATOR_PRIVATE_KEY',
      'MATT_MINE_NFT_REWARD_SIGNER_PRIVATE_KEY',
      'MATT_MINE_NFT_CONFIG_OPERATOR_PRIVATE_KEY'
    ]) {
      assert.match(blueprint, new RegExp(`key: ${key}\\r?\\n\\s+sync: false`));
    }
  });
});
