import { expect, test } from '@playwright/test';

const ADDRESS = `0x${'2'.repeat(40)}`;

test('ordinary browsers can sign in through the WalletConnect fallback', async ({ page }) => {
  await page.route('**/generated/walletconnect/walletconnect.js', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `
      export async function createWalletConnectProvider(options) {
        window.__mattMineWalletConnectOptions = options;
        return {
          session: null,
          async connect() {
            this.session = { topic: 'browser-test' };
            window.__mattMineWalletConnectOpened = true;
          },
          async request({ method }) {
            if (method === 'eth_requestAccounts') return ['${ADDRESS}'];
            if (method === 'eth_chainId') return '0x7e4';
            if (method === 'personal_sign') return '0x${'b'.repeat(130)}';
            throw new Error('Unexpected wallet request: ' + method);
          },
          on() {},
          removeListener() {}
        };
      }
    `
  }));
  await page.route('**/api/auth/challenge', (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      challenge: { nonce: 'c'.repeat(24), message: 'Sign in to MATT Mine' }
    })
  }));
  await page.route('**/api/auth/verify', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      session: {
        token: 'd'.repeat(64),
        address: ADDRESS,
        profile: { bankedNuggets: 0, bestDepth: 0, bestScore: 0, totalRuns: 0, meta: {} },
        identity: { name: 'WalletConnect Miner', requiresSetup: false },
        entitlements: { freeRunAvailable: true },
        suspended: false
      }
    })
  }));

  await page.goto('/');
  await expect(page.locator('#launch-wallet-label')).toHaveText('WALLETCONNECT');
  await expect(page.locator('#wallet-label')).toHaveText('CONNECT WALLET');
  await page.locator('#launch-wallet-button').click();

  await expect(page.locator('#launch-wallet-label')).toHaveText('WalletConnect Miner');
  const walletConnect = await page.evaluate(() => ({
    opened: window.__mattMineWalletConnectOpened,
    projectId: window.__mattMineWalletConnectOptions?.projectId,
    chains: window.__mattMineWalletConnectOptions?.chains
  }));
  expect(walletConnect).toEqual({
    opened: true,
    projectId: '11111111111111111111111111111111',
    chains: [2020]
  });
});

test('the generated WalletConnect browser bundle is served by the app', async ({ request }) => {
  const response = await request.get('/generated/walletconnect/walletconnect.js');
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('text/javascript');
});
