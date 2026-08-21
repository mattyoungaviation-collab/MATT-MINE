import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('home, briefing, and mine selection form one deliberate player journey', async () => {
  const [html, source, css] = await Promise.all([
    readFile(new URL('index.html', root), 'utf8'),
    readFile(new URL('src/main.js', root), 'utf8'),
    readFile(new URL('src/player-journey.css', root), 'utf8')
  ]);

  assert.match(html, /data-launch-action="how-to-play"[\s\S]*START HERE/);
  assert.match(html, /id="how-to-play"[\s\S]*CHOOSE YOUR MINE &rarr;/);
  assert.match(html, /id="menu"[\s\S]*STEP 3 · CHOOSE YOUR ROUTE/);
  assert.match(html, /PRACTICE MINE[\s\S]*MATT ARENA[\s\S]*PASS MINE/);
  assert.match(html, /id="mines-miner-button"/);
  assert.match(source, /function openMines\(\)/);
  assert.match(source, /function openMineRoute\(destination\)/);
  assert.match(source, /pendingMineDestination === 'arena'/);
  assert.match(source, /pendingMineDestination === 'pass-mine'/);
  assert.match(source, /#practice-run-button'[\s\S]*RUN_MODES\.PRACTICE/);
  assert.match(css, /Home -> How to Play -> Choose Mine/);
  assert.match(css, /#menu \.run-mode-grid\.three-lobbies/);
});

test('rewarded mine choices preserve their destination through Miner selection', async () => {
  const source = await readFile(new URL('src/main.js', root), 'utf8');

  assert.match(source, /#paid-run-button'[\s\S]*openMineRoute\('pass-mine'\)/);
  assert.match(source, /#arena-button'[\s\S]*openMineRoute\('arena'\)/);
  assert.match(source, /mattmine:slot-enter'[\s\S]*openMineRoute\('arena'\)[\s\S]*openMineRoute\('pass-mine'\)/);
  assert.match(source, /const destination = pendingMineDestination;[\s\S]*openArena\(\)[\s\S]*openPassMine\(\)/);
  assert.match(source, /#miner-select-home'[\s\S]*pendingMineDestination = '';[\s\S]*openMines\(\)/);
});
