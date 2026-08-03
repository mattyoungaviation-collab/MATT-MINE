import { expect, test } from '@playwright/test';

test('desktop player navigation opens every redesigned public surface', async ({ page }) => {
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.goto('/');

  await expect(page.locator('#launch-nugget-button')).toBeVisible();
  await page.locator('#launch-nugget-button').click();
  await expect(page.locator('#nugget-shop')).toHaveClass(/active/);
  await expect(page.locator('#nugget-shop-status')).toContainText('Sign in with Ronin Wallet');
  await page.locator('#nugget-shop-close').click();
  await expect(page.locator('#launch')).toHaveClass(/active/);

  await page.locator('[data-launch-action="enter"].launch-primary-cta').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);

  await page.locator('[data-mine-slot="daily"]').click();
  await expect(page.locator('#mine-detail')).toHaveClass(/active/);
  await page.locator('#mine-detail [data-mine-enter]').click();
  await expect(page.locator('#daily-mine')).toHaveClass(/active/);
  await expect(page.locator('#daily-mine-title')).toHaveText('Daily Mine');
  await page.locator('#daily-back-button').click();

  await page.locator('[data-mine-slot="pass"]').click();
  await expect(page.locator('#mine-detail')).toHaveClass(/active/);
  await page.locator('#mine-detail [data-mine-enter]').click();
  await expect(page.locator('#pass-mine')).toHaveClass(/active/);
  await expect(page.locator('#pass-mine-title')).toHaveText('Pass Mine');
  await page.locator('#pass-mine-back-button').click();

  await page.locator('#leaderboards-button').click();
  await expect(page.locator('#leaderboards')).toHaveClass(/active/);
  await page.locator('#leaderboards [data-close]').click();

  await page.locator('#pass-button').click();
  await expect(page.locator('#mine-pass')).toHaveClass(/active/);
  await page.locator('#mine-pass [data-close]').click();

  await page.locator('[data-mine-slot="arena"]').click();
  await expect(page.locator('#mine-detail')).toHaveClass(/active/);
  await page.locator('#mine-detail [data-mine-enter]').click();
  await expect(page.locator('#daily-arena')).toHaveClass(/active/);
  await page.locator('#daily-arena [data-close]').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  expect(runtimeErrors).toEqual([]);
});

test('profile tabs, store return path, and shared color accents remain usable', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === 'miner-profile'));
    document.body.classList.remove('launch-active');
  });
  await expect(page.locator('#miner-profile')).toHaveClass(/active/);

  for (const tab of ['upgrades', 'loadout', 'history', 'controls', 'overview']) {
    await page.locator(`[data-profile-tab="${tab}"]`).click();
    await expect(page.locator(`[data-profile-panel="${tab}"]`)).toHaveClass(/active/);
  }

  await page.locator('#profile-open-store-button').click();
  await expect(page.locator('#nugget-shop')).toHaveClass(/active/);
  await page.locator('#nugget-shop-close').click();
  await expect(page.locator('#miner-profile')).toHaveClass(/active/);

  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      gold: style.getPropertyValue('--ui-gold').trim(),
      purple: style.getPropertyValue('--ui-purple').trim(),
      cyan: style.getPropertyValue('--ui-cyan').trim()
    };
  });
  expect(colors).toEqual({ gold: '#f7c430', purple: '#a34fff', cyan: '#38d8ff' });
});
