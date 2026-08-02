import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resetWalletConnectProviderForTesting,
  resolveRoninProvider
} from '../src/game/walletProvider.js';

const PROJECT_ID = '1234567890abcdef1234567890abcdef';

test('the browser wallet resolver always prefers the injected Ronin provider', async () => {
  const injected = { request: async () => [] };
  const windowObject = { ronin: { provider: injected } };
  const resolved = await resolveRoninProvider({
    windowObject,
    config: { walletConnect: { enabled: true, projectId: PROJECT_ID } },
    createWalletConnectProvider() {
      throw new Error('WalletConnect must not load when Ronin is injected.');
    }
  });

  assert.equal(resolved.provider, injected);
  assert.equal(resolved.kind, 'injected');
});

test('the browser wallet resolver initializes one Ronin Mainnet WalletConnect session', async () => {
  const windowObject = { location: { origin: 'https://matt-mine.onrender.com' } };
  const initialized = [];
  let connectCalls = 0;
  const provider = {
    session: null,
    request: async () => [],
    on(event, handler) {
      if (event === 'display_uri') this.displayUriHandler = handler;
    },
    removeListener(event, handler) {
      if (event === 'display_uri' && this.displayUriHandler === handler) this.displayUriHandler = null;
    },
    async connect() {
      connectCalls += 1;
      this.displayUriHandler?.('wc:test-pairing@2?relay-protocol=irn');
      this.session = { topic: 'connected' };
    }
  };
  const createWalletConnectProvider = async (options) => {
    initialized.push(options);
    return provider;
  };

  let displayUri = '';
  const first = await resolveRoninProvider({
    windowObject,
    config: { walletConnect: { enabled: true, projectId: PROJECT_ID } },
    createWalletConnectProvider,
    showQrModal: false,
    onDisplayUri: (uri) => { displayUri = uri; }
  });
  const second = await resolveRoninProvider({
    windowObject,
    config: { walletConnect: { enabled: true, projectId: PROJECT_ID } },
    createWalletConnectProvider
  });

  assert.equal(first.provider, provider);
  assert.equal(second.provider, provider);
  assert.equal(first.kind, 'walletconnect');
  assert.equal(initialized.length, 1);
  assert.equal(connectCalls, 1);
  assert.deepEqual(initialized[0].optionalChains, [2020]);
  assert.equal(initialized[0].chains, undefined);
  assert.equal(initialized[0].projectId, PROJECT_ID);
  assert.equal(initialized[0].showQrModal, false);
  assert.equal(initialized[0].qrModalOptions.enableMobileFullScreen, true);
  assert.equal(initialized[0].metadata.url, 'https://matt-mine.onrender.com');
  assert.equal(displayUri, 'wc:test-pairing@2?relay-protocol=irn');
  resetWalletConnectProviderForTesting(windowObject);
});

test('the browser wallet resolver can explicitly choose WalletConnect beside injected Ronin', async () => {
  const injected = { request: async () => [] };
  const walletConnect = {
    session: { topic: 'already-connected' },
    request: async () => []
  };
  const windowObject = {
    ronin: { provider: injected },
    location: { origin: 'https://matt-mine.onrender.com' }
  };
  const resolved = await resolveRoninProvider({
    windowObject,
    config: { walletConnect: { enabled: true, projectId: PROJECT_ID } },
    forceWalletConnect: true,
    createWalletConnectProvider: async () => walletConnect
  });

  assert.equal(resolved.provider, walletConnect);
  assert.equal(resolved.kind, 'walletconnect');
  resetWalletConnectProviderForTesting(windowObject);
});

test('the browser wallet resolver explains when the public project ID is not configured', async () => {
  const windowObject = {};
  await assert.rejects(
    resolveRoninProvider({
      windowObject,
      config: { walletConnect: { enabled: false, projectId: '' } }
    }),
    /WalletConnect is not configured yet/
  );
});
