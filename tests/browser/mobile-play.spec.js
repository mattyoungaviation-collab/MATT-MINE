import { expect, test } from '@playwright/test';

test.describe('Ronin mobile play', () => {
  test.describe.configure({ timeout: 60_000 });
  test.use({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3
  });

  test('starts portrait play directly without a rotation gate', async ({ page }) => {
    await page.goto('/');

    const wallet = page.locator('#launch-walletconnect-button');
    await expect(wallet).toBeVisible();
    const walletBox = await wallet.boundingBox();
    expect(walletBox?.height).toBeGreaterThanOrEqual(44);

    const practice = page.locator('[data-launch-action="practice"].launch-secondary-cta');
    const dailyCard = page.locator('.launch-daily-card');
    const practiceBox = await practice.boundingBox();
    const dailyCardBox = await dailyCard.boundingBox();
    expect(practiceBox).not.toBeNull();
    expect(dailyCardBox).not.toBeNull();
    expect(practiceBox.y + practiceBox.height).toBeLessThan(dailyCardBox.y);

    await practice.click();
    await expect(page.locator('#mobile-orientation-gate')).toHaveCount(0);
    await expect(page.locator('#hud')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('.screen.active')).toHaveCount(0);
    await expect(page.locator('#app')).toHaveClass(/portrait-mobile/);
    await expect(page.locator('#game')).toHaveAttribute('data-orientation', 'portrait');
  });

  test('separates portrait controls from the playable canvas', async ({ page }) => {
    await page.goto('/');
    await page.locator('[data-launch-action="practice"].launch-secondary-cta').click();

    await expect(page.locator('#hud')).toHaveClass(/active/, { timeout: 15_000 });
    await expect(page.locator('#mobile-controls')).toBeVisible();
    await expect(page.locator('#joystick')).toBeVisible();
    await expect(page.locator('#dash-button')).toBeVisible();
    await expect(page.locator('.mobile-weapon-buttons')).toBeVisible();
    await expect(page.locator('#attack-button')).toBeVisible();

    const controls = await page.evaluate(() => {
      const rectangle = (selector) => {
        const rect = document.querySelector(selector).getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      };
      const overlaps = (one, two) => !(
        one.right <= two.left || one.left >= two.right || one.bottom <= two.top || one.top >= two.bottom
      );
      const canvas = rectangle('#game');
      const deck = rectangle('.mobile-control-deck');
      const joystick = rectangle('#joystick');
      const dash = rectangle('#dash-button');
      const weapons = rectangle('.mobile-weapon-buttons');
      const attack = rectangle('#attack-button');
      return {
        joystick,
        dash,
        weapons,
        attack,
        canvas,
        deck,
        overlaps: [
          overlaps(joystick, dash),
          overlaps(joystick, weapons),
          overlaps(joystick, attack),
          overlaps(dash, weapons),
          overlaps(dash, attack),
          overlaps(weapons, attack)
        ]
      };
    });
    expect(controls.overlaps).toEqual([false, false, false, false, false, false]);
    expect(controls.canvas.bottom).toBeLessThanOrEqual(controls.deck.top + 1);

    const canvas = await page.locator('#game').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        pixelWidth: element.width,
        pixelHeight: element.height,
        cssWidth: rect.width,
        cssHeight: rect.height,
        filter: getComputedStyle(element).filter,
        logicalWidth: Number(element.dataset.logicalWidth),
        logicalHeight: Number(element.dataset.logicalHeight)
      };
    });
    expect(canvas.cssHeight).toBeGreaterThan(canvas.cssWidth);
    expect(canvas.filter).toContain('brightness(1.65)');
    expect(canvas.logicalHeight).toBeGreaterThan(canvas.logicalWidth);
    expect(canvas.pixelWidth).toBeLessThanOrEqual(Math.ceil(canvas.cssWidth * 1.5));
    expect(canvas.pixelHeight).toBeLessThanOrEqual(Math.ceil(canvas.cssHeight * 1.5));
    expect(canvas.pixelWidth).toBeLessThan(2_560);
    expect(canvas.pixelHeight).toBeLessThan(1_440);
  });

  test('does not invoke native fullscreen from a portrait start', async ({ page }) => {
    await page.addInitScript(() => {
      Element.prototype.requestFullscreen = function requestFullscreen(options) {
        window.__mattMineFullscreenRequest = { id: this.id, options };
        return Promise.resolve();
      };
    });
    await page.goto('/');
    await page.locator('[data-launch-action="practice"].launch-secondary-cta').click();

    await expect(page.locator('html')).toHaveClass(/mobile-gameplay-fullscreen/);
    await expect(page.locator('#hud')).toHaveClass(/active/, { timeout: 15_000 });
    expect(await page.evaluate(() => window.__mattMineFullscreenRequest)).toBeUndefined();
  });
});
