import { expect, test } from '@playwright/test';

test.describe('Ronin mobile play', () => {
  test.use({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3
  });

  test('keeps the launch actions clear and protects portrait run starts', async ({ page }) => {
    await page.goto('/');

    const wallet = page.locator('#launch-wallet-button');
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
    const orientationGate = page.locator('#mobile-orientation-gate');
    await expect(orientationGate).toBeVisible();
    await expect(orientationGate).toContainText('Rotate to start your run');
    await expect(orientationGate).toContainText('no entry has been used');

    await page.locator('#mobile-orientation-cancel').click();
    await expect(orientationGate).toBeHidden();
    await expect(page.locator('#launch')).toHaveClass(/active/);
    await expect(page.locator('#hud')).not.toHaveClass(/active/);
  });

  test('shows separated touch controls and scales the canvas in landscape', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 390 });
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
      const joystick = rectangle('#joystick');
      const dash = rectangle('#dash-button');
      const weapons = rectangle('.mobile-weapon-buttons');
      const attack = rectangle('#attack-button');
      return {
        joystick,
        dash,
        weapons,
        attack,
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

    const canvas = await page.locator('#game').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return {
        pixelWidth: element.width,
        pixelHeight: element.height,
        cssWidth: rect.width,
        cssHeight: rect.height
      };
    });
    expect(canvas.pixelWidth).toBeLessThanOrEqual(Math.ceil(canvas.cssWidth * 1.5));
    expect(canvas.pixelHeight).toBeLessThanOrEqual(Math.ceil(canvas.cssHeight * 1.5));
    expect(canvas.pixelWidth).toBeLessThan(2_560);
    expect(canvas.pixelHeight).toBeLessThan(1_440);
  });
});
