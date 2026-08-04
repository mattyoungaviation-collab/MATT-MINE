import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

import { defaultCompetitionStudio } from '../../src/game/competitionStudio.js';

test('Competition Studio downloads and reimports a complete local mine file without publishing', async ({ page }) => {
  const mutationRequests = [];
  page.on('request', (request) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method())) mutationRequests.push(request.url());
  });
  const now = Date.UTC(2026, 7, 4, 12, 0, 0);
  const studio = defaultCompetitionStudio(now);
  studio.slots.practice.draft.name = 'Saved Practice Gauntlet';
  studio.slots.practice.draft.depths[1].map.name = 'Saved Practice Depth Two';
  studio.slots.practice.draft.monsterTuning.depth2SlimeHealth = 222;

  await page.route('**/api/admin/competition-studio', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true, studio, active: {} })
  }));
  await page.goto('/admin.html');
  await page.waitForFunction(() => Boolean(window.mattMineCompetitionStudio?.load));
  await page.evaluate(async () => {
    document.querySelector('#unlock-panel').hidden = true;
    document.querySelector('#dashboard').hidden = false;
    document.querySelector('#tab-studio').classList.add('active');
    await window.mattMineCompetitionStudio.load();
  });

  await expect(page.locator('#studio-library-mine')).toContainText('Practice Mine');
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#studio-export-map').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^matt-mine-practice-saved-practice-gauntlet-.+\.mattmine\.json$/);
  const downloadedPath = await download.path();
  const mapFile = JSON.parse(await readFile(downloadedPath, 'utf8'));
  expect(mapFile).toMatchObject({
    format: 'matt-mine-competition-map',
    version: 1,
    mineType: 'practice',
    name: 'Saved Practice Gauntlet'
  });
  expect(mapFile.draft.depths).toHaveLength(5);
  expect(mapFile.draft.depths[1].map.name).toBe('Saved Practice Depth Two');
  expect(mapFile.draft.monsterTuning.depth2SlimeHealth).toBe(222);

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#studio-import-map-file').setInputFiles(downloadedPath);
  await expect(page.locator('#studio-save-state')).toHaveText('IMPORTED · UNSAVED');
  await expect(page.locator('#studio-map-name')).toContainText(mapFile.draft.depths[0].map.name);
  await expect(page.locator('#studio-library-status')).toContainText('review, edit, then save the draft');
  expect(mutationRequests).toEqual([]);
});
