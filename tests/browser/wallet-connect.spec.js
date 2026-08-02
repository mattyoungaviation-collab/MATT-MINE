import { expect, test } from '@playwright/test';

const ADDRESS = `0x${'2'.repeat(40)}`;

test('ordinary browsers can sign in through the WalletConnect fallback', async ({ page }) => {
  await page.route('**/generated/walletconnect/walletconnect.js*', (route) => route.fulfill({
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
  await expect(page.locator('#launch-wallet-button')).toBeHidden();
  await expect(page.locator('#launch-walletconnect-button')).toBeVisible();
  await page.locator('#launch-walletconnect-button').click();

  await expect(page.locator('#launch-wallet-label')).toHaveText('WalletConnect Miner');
  const walletConnect = await page.evaluate(() => ({
    opened: window.__mattMineWalletConnectOpened,
    projectId: window.__mattMineWalletConnectOptions?.projectId,
    optionalChains: window.__mattMineWalletConnectOptions?.optionalChains
  }));
  expect(walletConnect).toEqual({
    opened: true,
    projectId: '11111111111111111111111111111111',
    optionalChains: [2020]
  });
});

test('iPhone Safari gets a user-tapped Ronin Wallet handoff instead of a stalled QR modal', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'userAgent', {
      configurable: true,
      value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1'
    });
  });
  await page.route('**/generated/walletconnect/walletconnect.js*', (route) => route.fulfill({
    status: 200,
    contentType: 'text/javascript',
    body: `
      export async function createWalletConnectProvider(options) {
        window.__mattMineWalletConnectOptions = options;
        let displayUri;
        return {
          session: null,
          on(event, handler) { if (event === 'display_uri') displayUri = handler; },
          removeListener() {},
          request: async () => [],
          connect() {
            displayUri('wc:mobile-test@2?relay-protocol=irn&symKey=abc123');
            return new Promise(() => {});
          }
        };
      }
    `
  }));

  await page.goto('/');
  await page.locator('#launch-walletconnect-button').click();

  const dialog = page.locator('#walletconnect-mobile-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Connect on this phone');
  const openRonin = page.locator('#walletconnect-open-ronin');
  await expect(openRonin).toHaveAttribute('href', /^roninwallet:\/\/wc\?uri=wc%3Amobile-test/);
  expect(await page.evaluate(() => window.__mattMineWalletConnectOptions)).toMatchObject({
    optionalChains: [2020],
    showQrModal: false
  });
});

test('injected Ronin browsers still show the explicit WalletConnect choice', async ({ page }) => {
  await page.addInitScript(() => {
    window.ronin = { provider: { request: async () => [] } };
  });
  await page.goto('/');

  await expect(page.locator('#launch-wallet-label')).toHaveText('CONNECT RONIN');
  await expect(page.locator('#launch-wallet-button')).toBeVisible();
  await expect(page.locator('#launch-walletconnect-button')).toBeVisible();
});

test('the generated WalletConnect browser bundle is served by the app', async ({ request }) => {
  const response = await request.get('/generated/walletconnect/walletconnect.js?v=browser-test');
  expect(response.ok()).toBeTruthy();
  expect(response.headers()['content-type']).toContain('text/javascript');
  expect(response.headers()['cache-control']).toBe('no-cache');
});
