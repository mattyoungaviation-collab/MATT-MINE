import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('approved UI refresh exposes every player dashboard and unique control id', async () => {
  const html = await readFile(new URL('index.html', root), 'utf8');
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);

  assert.deepEqual(duplicates, []);
  for (const id of [
    'site-nav', 'site-account-button', 'site-account-label',
    'how-to-play', 'how-to-title', 'launch-mine-select-title',
    'launch-nugget-button', 'daily-mine', 'start-daily-run-button',
    'pass-mine', 'start-pass-mine-button', 'buy-pass-credit-button',
    'miner-profile', 'profile-open-store-button', 'profile-manage-upgrades-button',
    'profile-manage-loadout-button', 'profile-recent-runs', 'profile-full-run-history',
    'leaderboard-podium'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.equal((html.match(/data-profile-tab=/g) || []).length, 5);
  assert.equal((html.match(/class="launch-mine-card /g) || []).length, 4);
  assert.match(html, /data-site-action="how-to-play"/);
  assert.match(html, /data-site-action="store"/);
  assert.match(html, /data-launch-action="daily"/);
  assert.match(html, /data-launch-action="pass-mine"/);
  assert.match(html, /class="leaderboard-tab arena-leaderboard-tab" data-board="arena"/);
  assert.match(html, /src\/ui-refresh\.css/);
});

test('UI controls are wired to existing run, Pass, leaderboard, loadout, and shop flows', async () => {
  const [source, shop] = await Promise.all([
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/nuggetShop.js', root), 'utf8')
  ]);

  assert.match(source, /#free-run-button'\)\.addEventListener\('click', openDailyMine\)/);
  assert.match(source, /#start-daily-run-button'[\s\S]*startRunMode\(RUN_MODES\.FREE\)/);
  assert.match(source, /#start-pass-mine-button'[\s\S]*startRunMode\(RUN_MODES\.PAID\)/);
  assert.match(source, /#pass-mine-leaderboard-button'[\s\S]*openLeaderboards\(RUN_MODES\.PAID\)/);
  assert.match(source, /#profile-manage-upgrades-button'[\s\S]*showScreen\('upgrade-shop'\)/);
  assert.match(source, /#profile-manage-loadout-button'[\s\S]*openCosmetics\(\)/);
  assert.match(source, /action === 'how-to-play'[\s\S]*showScreen\('how-to-play'\)/);
  assert.match(source, /action === 'store'[\s\S]*mattmine:open-nugget-shop/);
  assert.match(source, /renderLeaderboardPodium\(rows\)/);
  assert.match(source, /mode === ARENA_LEADERBOARD_MODE/);
  assert.match(source, /await refreshArena\(true\)/);
  assert.match(shop, /\[data-open-nugget-shop\]/);
  assert.match(shop, /mattmine:open-nugget-shop/);
});

test('live dashboards poll only while visible and the shared theme covers popups', async () => {
  const [source, css] = await Promise.all([
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/ui-refresh.css', root), 'utf8')
  ]);

  assert.match(source, /document\.visibilityState === 'visible'/);
  assert.match(source, /app\.classList\.contains\('gameplay-active'\)/);
  assert.match(source, /30_000/);
  assert.match(source, /apiClient\.me\(\)/);
  assert.match(css, /--ui-gold: #f7c430/);
  assert.match(css, /--ui-purple: #a34fff/);
  assert.match(css, /--ui-cyan: #38d8ff/);
  assert.match(css, /dialog\.walletconnect-mobile-dialog/);
  assert.match(css, /dialog#arena-eligibility-dialog/);
  assert.match(css, /\.site-nav/);
  assert.match(css, /\.launch-mine-card-grid/);
  assert.match(css, /\.how-to-steps/);
  assert.match(css, /\.leaderboard-podium/);
  assert.doesNotMatch(css, /\.leaderboard-tabs::after/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /#run-end \.panel/);
  assert.match(css, /#level-up \.panel/);
});
