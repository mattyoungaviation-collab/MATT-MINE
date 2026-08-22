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
    'miner-select', 'miner-number-form', 'miner-number-input', 'miner-number-submit',
    'miner-select-grid', 'select-loadout-button', 'enter-mines-button',
    'miner-command-center', 'garage-crystal-balance', 'garage-loadout-slots',
    'garage-equipment-list', 'garage-repair-button', 'garage-withdraw-button',
    'how-to-play', 'how-to-title', 'launch-mine-select-title',
    'practice-run-button', 'arena-button',
    'mines-how-to-button', 'mines-miner-button',
    'pass-mine', 'paid-run-button', 'start-pass-mine-button', 'buy-pass-credit-button',
    'miner-profile', 'profile-manage-loadout-button', 'profile-recent-runs', 'profile-full-run-history',
    'leaderboard-podium'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.equal((html.match(/data-profile-tab=/g) || []).length, 4);
  assert.equal((html.match(/class="launch-mine-card /g) || []).length, 3);
  assert.match(html, /data-site-action="how-to-play"/);
  assert.match(html, /data-launch-action="practice"/);
  assert.match(html, /data-launch-action="arena"/);
  assert.match(html, /data-launch-action="pass-mine"/);
  assert.match(html, /id="select-loadout-button"[^>]*>MANAGE LOADOUT</);
  assert.doesNotMatch(html, /id="select-loadout-button"[^>]*href="\.\/nft-lab\.html"/);
  assert.match(html, /id="miner-number-input"[^>]*min="1"[^>]*max="1000"/);
  assert.match(html, /class="leaderboard-tab arena-leaderboard-tab active" data-board="arena"/);
  assert.doesNotMatch(html, /FREE DAILY MINE|SEVEN-DAY MINE|ENDLESS MINE|PVP MINE/i);
  assert.match(html, /src\/ui-refresh\.css/);
  assert.match(html, /src\/player-journey\.css/);
});

test('UI controls are wired to existing run, Pass, leaderboard, and loadout flows', async () => {
  const source = await readFile(new URL('src/main.js', root), 'utf8');

  assert.match(source, /#practice-run-button'\)\.addEventListener\('click',[\s\S]*startRunMode\(RUN_MODES\.PRACTICE\)/);
  assert.match(source, /apiClient\.startArenaRun\(selectedNftMinerId, '', approval\)/);
  assert.match(source, /#start-pass-mine-button'[\s\S]*startRunMode\(RUN_MODES\.PAID\)/);
  assert.match(source, /#pass-mine-leaderboard-button'[\s\S]*openLeaderboards\(RUN_MODES\.PAID\)/);
  assert.match(source, /#profile-manage-loadout-button'[\s\S]*openCosmetics\(\)/);
  assert.match(source, /action === 'how-to-play'[\s\S]*showScreen\('how-to-play'\)/);
  assert.match(source, /openMinerSelect\(\)/);
  assert.match(source, /apiClient\.ownedMiner\(minerId\)/);
  assert.match(source, /apiClient\.startRun\(mode, minerId, approval\)/);
  assert.match(source, /openMinerCommandCenter\(\)/);
  assert.match(source, /nftGarage\.withdrawCrystals\(snapshot, amountRaw\)/);
  assert.match(source, /renderLeaderboardPodium\(rows\)/);
  assert.match(source, /mode === ARENA_LEADERBOARD_MODE/);
  assert.match(source, /await refreshArena\(true\)/);
  assert.doesNotMatch(source, /nugget|permanent.?upgrade/i);
});

test('live dashboards poll only while visible and the shared theme covers popups', async () => {
  const [source, refreshCss, journeyCss] = await Promise.all([
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/ui-refresh.css', root), 'utf8'),
    readFile(new URL('src/player-journey.css', root), 'utf8')
  ]);
  const css = `${refreshCss}\n${journeyCss}`;

  assert.match(source, /document\.visibilityState === 'visible'/);
  assert.match(source, /app\.classList\.contains\('gameplay-active'\)/);
  assert.match(source, /30_000/);
  assert.match(source, /apiClient\.me\(\)/);
  assert.match(css, /--ui-gold: #ffd84a/);
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
