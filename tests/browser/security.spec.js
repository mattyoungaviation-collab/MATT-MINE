import { expect, test } from '@playwright/test';

test('Admin login exposes wallet authentication and no browser master-secret field', async ({ page }) => {
  await page.goto('/admin.html');
  await expect(page.getByRole('button', { name: 'Sign in with Ronin Wallet' })).toBeVisible();
  await expect(page.locator('#admin-key')).toHaveCount(0);
  const keys = await page.evaluate(() => Object.keys(sessionStorage));
  expect(keys).not.toContain('mattMineAdminKey');
});

test('Admin login exchanges the nested verified player token for an Admin session', async ({ page }) => {
  const address = `0x${'1'.repeat(40)}`;
  const playerToken = 'a'.repeat(64);

  await page.addInitScript(({ walletAddress }) => {
    window.ronin = {
      provider: {
        request: async ({ method }) => {
          if (method === 'eth_requestAccounts') return [walletAddress];
          if (method === 'eth_chainId') return '0x7e4';
          if (method === 'personal_sign') return `0x${'b'.repeat(130)}`;
          throw new Error(`Unexpected wallet request: ${method}`);
        }
      }
    };
  }, { walletAddress: address });

  await page.route('**/api/auth/challenge', (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, challenge: { nonce: 'c'.repeat(24), message: 'Sign in to MATT Mine' } })
  }));
  await page.route('**/api/auth/verify', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, session: { token: playerToken } })
  }));
  await page.route('**/api/admin/auth/session', (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, admin: { address, expiresAt: Date.now() + 60_000 }, csrfToken: 'csrf-token' })
  }));
  await page.route('**/api/auth/logout', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, signedOut: true })
  }));

  await page.goto('/admin.html');
  const adminSessionRequest = page.waitForRequest((request) => request.url().endsWith('/api/admin/auth/session'));
  const logoutRequest = page.waitForRequest((request) => request.url().endsWith('/api/auth/logout'));
  await page.getByRole('button', { name: 'Sign in with Ronin Wallet' }).click();

  expect((await adminSessionRequest).headers().authorization).toBe(`Bearer ${playerToken}`);
  expect((await logoutRequest).headers().authorization).toBe(`Bearer ${playerToken}`);
});

test('liveness and readiness are distinct', async ({ request }) => {
  const live = await request.get('/api/live');
  expect(live.ok()).toBeTruthy();
  const body = await live.json();
  expect(body).toMatchObject({ ok: true, service: 'matt-mine' });
  const ready = await request.get('/api/ready');
  expect([200, 503]).toContain(ready.status());
});
