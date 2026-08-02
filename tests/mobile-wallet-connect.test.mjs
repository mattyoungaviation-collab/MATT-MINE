import test from 'node:test';
import assert from 'node:assert/strict';

import {
  needsMobileWalletConnectHandoff,
  rememberRoninWalletChoice,
  roninWalletPairingUrl
} from '../src/game/mobileWalletConnect.js';

test('iPhone Safari uses the explicit Ronin mobile handoff', () => {
  assert.equal(needsMobileWalletConnectHandoff({
    navigator: { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', maxTouchPoints: 5 }
  }), true);
  assert.equal(needsMobileWalletConnectHandoff({
    navigator: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', maxTouchPoints: 0 }
  }), false);
});

test('Ronin pairing links preserve the complete WalletConnect URI', () => {
  const uri = 'wc:abc123@2?relay-protocol=irn&symKey=secret';
  assert.equal(roninWalletPairingUrl(uri), `roninwallet://wc?uri=${encodeURIComponent(uri)}`);
  assert.throws(() => roninWalletPairingUrl('https://example.com'), /valid pairing link/);
});

test('the Ronin deep-link choice is remembered for later signing requests', () => {
  const stored = new Map();
  rememberRoninWalletChoice({ localStorage: { setItem: (key, value) => stored.set(key, value) } });
  assert.deepEqual(JSON.parse(stored.get('WALLETCONNECT_DEEPLINK_CHOICE')), {
    href: 'roninwallet://',
    name: 'Ronin Wallet'
  });
});
