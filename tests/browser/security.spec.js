import { expect, test } from '@playwright/test';

test('Admin login exposes wallet authentication and no browser master-secret field', async ({ page }) => {
  await page.goto('/admin.html');
  await expect(page.getByRole('button', { name: 'Sign in with Ronin Wallet' })).toBeVisible();
  await expect(page.locator('#admin-key')).toHaveCount(0);
  const keys = await page.evaluate(() => Object.keys(sessionStorage));
  expect(keys).not.toContain('mattMineAdminKey');
});

test('liveness and readiness are distinct', async ({ request }) => {
  const live = await request.get('/api/live');
  expect(live.ok()).toBeTruthy();
  const body = await live.json();
  expect(body).toMatchObject({ ok: true, service: 'matt-mine' });
  const ready = await request.get('/api/ready');
  expect([200, 503]).toContain(ready.status());
});
