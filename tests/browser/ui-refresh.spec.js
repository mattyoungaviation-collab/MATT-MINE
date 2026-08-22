import { expect, test } from '@playwright/test';

const NFT_TEST_ADDRESS = `0x${'3'.repeat(40)}`;

async function installSignedInMiner(page, options = {}) {
  const minerId = options.minerId || 1;
  const includeMinerInSignIn = options.includeMinerInSignIn !== false;
  await page.addInitScript(({ address }) => {
    window.ronin = {
      provider: {
        async request({ method }) {
          if (method === 'eth_requestAccounts') return [address];
          if (method === 'eth_chainId') return '0x7e4';
          if (method === 'personal_sign') return `0x${'b'.repeat(130)}`;
          throw new Error(`Unexpected wallet request: ${method}`);
        },
        on() {},
        removeListener() {}
      }
    };
  }, { address: NFT_TEST_ADDRESS });
  await page.route('**/api/auth/challenge', (route) => route.fulfill({
    status: 201,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, challenge: { nonce: 'c'.repeat(24), message: 'Sign in to MATT Mine' } })
  }));
  await page.route('**/api/auth/verify', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      session: {
        token: 'd'.repeat(64),
        address: NFT_TEST_ADDRESS,
        profile: { bestDepth: 0, bestScore: 0, totalRuns: 0 },
        identity: { name: 'V2 Browser Miner', requiresSetup: false },
        entitlements: { freeRunAvailable: true },
        suspended: false,
        ...(includeMinerInSignIn ? { nftMiners: [{
          minerId,
          contractVersion: 'v2',
          progression: { level: 1, evolution: 0 },
          traits: {
            maximumHealth: 50,
            armorShield: 0,
            pickaxeAttack: 15,
            blasterAttack: 5,
            dynamiteAttack: 20,
            healAmount: 10,
            carryCapacity: 750,
            deathRetentionBps: 1000,
            crystalsPerHour: 0
          },
          gameplay: { runLocked: false, earningStatus: 'not_eligible' },
          equipped: {}
        }] } : {})
      }
    })
  }));
  await page.route(`**/api/me/miners/${minerId}`, (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      miner: {
        minerId,
        contractVersion: 'v2',
        owner: NFT_TEST_ADDRESS,
        progression: { level: 1, evolution: 0 },
        traits: {
          maximumHealth: 50,
          armorShield: 0,
          pickaxeAttack: 15,
          blasterAttack: 5,
          dynamiteAttack: 20,
          healAmount: 10,
          carryCapacity: 750,
          deathRetentionBps: 1000,
          crystalsPerHour: 0
        },
        gameplay: { runLocked: false, earningStatus: 'not_eligible' },
        equipped: {}
      }
    })
  }));
}

async function enterNftMineMenu(page) {
  await page.locator('[data-launch-action="mines"].launch-secondary-cta').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  await page.locator('#mines-miner-button').click();
  await expect(page.locator('#miner-select')).toHaveClass(/active/);
  await expect(page.locator('#selected-miner-name')).toHaveText('MATT MINE MINER #1');
  await expect(page.locator('#select-loadout-button')).toBeVisible();
  await expect(page.locator('#enter-mines-button')).toBeEnabled();
  await page.locator('#enter-mines-button').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
}

async function openMineFromHub(page, slotId, expectedName) {
  await page.locator(`[data-mine-slot="${slotId}"]`).click();
  await expect(page.locator('#mine-detail')).toHaveClass(/active/);
  await expect(page.locator('#mine-detail [data-mine-name]')).toHaveText(expectedName);
  await page.locator('#mine-detail [data-mine-enter]').click();
}

test('desktop player navigation opens every redesigned public surface', async ({ page }) => {
  const runtimeErrors = [];
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await installSignedInMiner(page);
  await page.goto('/');

  await enterNftMineMenu(page);
  await expect(page.locator('[data-mine-slot="practice"]')).toContainText('Practice Mine');
  await expect(page.locator('[data-mine-slot="arena"]')).toContainText('MATT Arena');
  await expect(page.locator('[data-mine-slot="pass"]')).toContainText('Pass Mine');

  await openMineFromHub(page, 'pass', 'Pass Mine');
  await expect(page.locator('#pass-mine')).toHaveClass(/active/);
  await expect(page.locator('#pass-mine-title')).toHaveText('Pass Mine');
  await page.locator('#pass-mine-back-button').click();

  await page.locator('#leaderboards-button').click();
  await expect(page.locator('#leaderboards')).toHaveClass(/active/);
  await page.locator('#site-nav [data-site-action="home"]').click();
  await expect(page.locator('#launch')).toHaveClass(/active/);

  await page.locator('[data-launch-action="mines"].launch-secondary-cta').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  await page.locator('#pass-button').click();
  await expect(page.locator('#mine-pass')).toHaveClass(/active/);
  await page.locator('#site-nav [data-site-action="home"]').click();
  await expect(page.locator('#launch')).toHaveClass(/active/);

  await enterNftMineMenu(page);
  await openMineFromHub(page, 'arena', 'MATT Arena');
  await expect(page.locator('#daily-arena')).toHaveClass(/active/);
  await page.locator('#daily-arena [data-close]').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  expect(runtimeErrors).toEqual([]);
});

test('fresh sign-in selects an owned Miner by number without visiting the loadout screen', async ({ page }) => {
  await installSignedInMiner(page, { includeMinerInSignIn: false, minerId: 777 });
  await page.goto('/');
  await page.locator('[data-launch-action="mines"].launch-secondary-cta').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
  await page.locator('#mines-miner-button').click();
  await expect(page.locator('#miner-select')).toHaveClass(/active/);
  await expect(page.locator('.miner-select-empty')).toContainText('SELECT A MINER NUMBER');
  await page.locator('#miner-number-input').fill('777');
  await page.locator('#miner-number-submit').click();
  await expect(page.locator('#selected-miner-name')).toHaveText('MATT MINE MINER #777');
  await expect(page.locator('#miner-number-status')).toContainText('You can enter the mines now');
  await expect(page.locator('#enter-mines-button')).toBeEnabled();
  await page.locator('#enter-mines-button').click();
  await expect(page.locator('#menu')).toHaveClass(/active/);
});

test('profile tabs and shared color accents remain usable', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => {
    document.querySelectorAll('.screen').forEach((screen) => screen.classList.toggle('active', screen.id === 'miner-profile'));
    document.body.classList.remove('launch-active');
  });
  await expect(page.locator('#miner-profile')).toHaveClass(/active/);

  for (const tab of ['loadout', 'history', 'controls', 'overview']) {
    await page.locator(`[data-profile-tab="${tab}"]`).click();
    await expect(page.locator(`[data-profile-panel="${tab}"]`)).toHaveClass(/active/);
  }

  const colors = await page.evaluate(() => {
    const style = getComputedStyle(document.documentElement);
    return {
      gold: style.getPropertyValue('--ui-gold').trim(),
      purple: style.getPropertyValue('--ui-purple').trim(),
      cyan: style.getPropertyValue('--ui-cyan').trim()
    };
  });
  expect(colors).toEqual({ gold: '#ffd84a', purple: '#a34fff', cyan: '#38d8ff' });
});

test('desktop leaderboard and Arena use the viewport without clipping tables', async ({ page }) => {
  await installSignedInMiner(page);
  await page.setViewportSize({ width: 1536, height: 1024 });
  await page.goto('/');
  await page.locator('#launch [data-launch-action="leaderboards"]').first().click();

  const leaderboardLayout = await page.locator('#leaderboards > .economy-panel').evaluate((panel) => ({
    width: panel.getBoundingClientRect().width,
    viewport: window.innerWidth,
    maxHeight: getComputedStyle(panel).maxHeight
  }));
  expect(leaderboardLayout.width).toBeGreaterThanOrEqual(leaderboardLayout.viewport - 2);
  expect(leaderboardLayout.maxHeight).toBe('none');

  await page.locator('#site-nav [data-site-action="home"]').click();
  await enterNftMineMenu(page);
  await openMineFromHub(page, 'arena', 'MATT Arena');
  const arenaTable = await page.locator('#daily-arena .arena-table-wrap').evaluate((table) => ({
    maxHeight: getComputedStyle(table).maxHeight,
    overflowY: getComputedStyle(table).overflowY
  }));
  expect(arenaTable.maxHeight).toBe('none');
  expect(['auto', 'visible']).toContain(arenaTable.overflowY);
});

test('desktop Arena leaderboard renders the live daily Arena dataset', async ({ page }) => {
  await page.route('**/api/arena/config', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      arena: {
        enabled: true,
        configured: true,
        status: 'open',
        day: '2026-08-04',
        prizePoolRaw: '1100000000000000000000000',
        feeRaw: '25000000000000000000000',
        seedRaw: '500000000000000000000000',
        entryPoolRaw: '600000000000000000000000'
      }
    })
  }));
  await page.route('**/api/arena/leaderboard?*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      leaderboard: {
        day: '2026-08-04',
        status: 'open',
        participantCount: 4,
        entryCount: 12,
        prizePoolRaw: '1100000000000000000000000',
        rows: [
          { rank: 1, address: '0x0000000000000000000000000000000000000001', walletId: 'Lucky1', score: 142592, entries: 2 },
          { rank: 2, address: '0x0000000000000000000000000000000000000002', walletId: 'Lord', score: 141947, entries: 4 },
          { rank: 3, address: '0x0000000000000000000000000000000000000003', walletId: 'Aeezy', score: 141690, entries: 1 },
          { rank: 4, address: '0x0000000000000000000000000000000000000004', walletId: 'Qweezatz', score: 97283, entries: 5 }
        ]
      }
    })
  }));

  await page.goto('/');
  await page.locator('#launch [data-launch-action="leaderboards"]').first().click();
  await page.locator('[data-board="arena"]').click();

  await expect(page.locator('[data-board="arena"]')).toHaveClass(/active/);
  await expect(page.locator('#board-pool-label')).toHaveText('Current Daily Pool');
  await expect(page.locator('#board-pool')).toHaveText('1,100,000 MATT');
  await expect(page.locator('.podium-place.place-1')).toContainText('Lucky1');
  await expect(page.locator('.podium-place.place-1')).toContainText('142,592');
  await expect(page.locator('#leaderboard-body')).toContainText('Qweezatz');
  await expect(page.locator('#leaderboard-body')).toContainText('97,283');
  await expect(page.locator('#leaderboard-note')).toContainText('2026-08-04 UTC');
});
