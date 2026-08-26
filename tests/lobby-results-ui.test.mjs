import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the production lobby presents exactly three live mines in one command deck', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const css = await readFile(`${root}src/production.css`, 'utf8');
  assert.match(html, /class="lobby-topbar"/);
  assert.match(html, /class="matchmaking-layout"/);
  assert.match(html, /class="mine-briefing-column"/);
  assert.match(html, /class="lobby-choice-column"/);
  assert.match(html, /class="menu-bottom-deck"/);

  const lobbyBlock = html.match(/<div class="run-mode-grid four-lobbies three-lobbies"[\s\S]*?<\/div>\s*<\/div>\s*<\/div>\s*<div class="mine-route-help">/)?.[0] || '';
  assert.equal((lobbyBlock.match(/class="run-mode-card/g) || []).length, 3);
  assert.match(lobbyBlock, /PRACTICE MINE/);
  assert.match(lobbyBlock, /MATT ARENA/);
  assert.match(lobbyBlock, /PASS MINE/);
  assert.doesNotMatch(lobbyBlock, /FREE DAILY|SEVEN-DAY|ENDLESS|PVP/i);
  const productionLobby = css.slice(css.lastIndexOf('/* Production lobby:'));
  assert.match(productionLobby, /#menu\.menu-v4:not\(\.active\)\s*\{\s*display:\s*none;/);
});

test('run results use a compact two-column layout with both exit actions grouped together', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const css = await readFile(`${root}src/production.css`, 'utf8');
  assert.match(html, /class="results-layout"/);
  assert.match(html, /class="results-summary-column"/);
  assert.match(html, /class="results-outcome-column"/);
  assert.match(html, /class="results-actions"/);
  assert.match(html, /id="menu-button"[^>]*>BACK TO MINER</);
  assert.match(css, /\.results-layout\s*\{[\s\S]*grid-template-columns:\s*minmax\(0,\s*0\.95fr\)\s+minmax\(0,\s*1\.05fr\)/);
  assert.match(css, /\.results-panel-v4\s*\{[\s\S]*max-height:\s*calc\(100dvh - 24px\)/);
});

test('practice reward controls remain hidden outside an active Practice result', async () => {
  const css = await readFile(`${root}src/production.css`, 'utf8');
  const source = await readFile(`${root}src/main.js`, 'utf8');
  assert.match(css, /\.practice-claim-card\[hidden\]\s*\{\s*display:\s*none;/);
  assert.match(source, /if\s*\(resultScreenMode !== RUN_MODES\.PRACTICE\)\s*\{\s*clearPracticeClaimPanel\(\);\s*return;/);
  assert.match(source, /resultScreenMode = mode;/);
  assert.match(source, /resultScreenMode = null;\s*clearPracticeClaimPanel\(\);/);
});

test('the Arena lobby exposes a signed-in recovery action for a stranded active run', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const apiSource = await readFile(`${root}src/game/apiClient.js`, 'utf8');
  const httpSource = await readFile(`${root}server/http.js`, 'utf8');

  assert.match(source, /RELEASE ACTIVE ARENA RUN/);
  assert.match(source, /await apiClient\.abandonActiveArenaRun\(\)/);
  assert.match(source, /consumed Arena entry remains used and no score will be recorded/);
  assert.match(apiSource, /\/api\/arena\/runs\/abandon-active/);
  assert.match(httpSource, /service\.abandonActiveArenaRun\(bearerToken\(request\)\)/);
});

test('the lobby exposes NFT Practice refresh recovery without reusing a lost run token', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const apiSource = await readFile(`${root}src/game/apiClient.js`, 'utf8');
  const httpSource = await readFile(`${root}server/http.js`, 'utf8');

  assert.match(html, /id="resume-nft-practice-button"/);
  assert.match(source, /serverPlayer\?\.interruptedNftPractice/);
  assert.match(source, /restartInterruptedNftPractice: true/);
  assert.match(apiSource, /\/api\/runs\/nft-practice\/restart/);
  assert.match(httpSource, /service\.restartInterruptedNftPractice\(bearerToken\(request\)\)/);
});

test('the Miner selector exposes an explicit on-chain orphan forfeit action', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const apiSource = await readFile(`${root}src/game/apiClient.js`, 'utf8');
  const httpSource = await readFile(`${root}server/http.js`, 'utf8');

  assert.match(source, /FORFEIT LOCKED RUN/);
  assert.match(source, /This does not resume the run/);
  assert.match(source, /recoverLockedMinerRun\(selectedNftMinerId\)/);
  assert.match(apiSource, /\/api\/nft\/v2\/runs\/recover/);
  assert.match(httpSource, /service\.recoverLockedMinerRun\(bearerToken\(request\), body\)/);
});

test('Miner selection, loadout, balances, repair, chests, and mine entry share one player flow', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const source = await readFile(`${root}src/main.js`, 'utf8');

  assert.match(html, /id="miner-command-center"/);
  assert.match(html, /id="garage-crystal-balance"/);
  assert.match(html, /id="garage-equipment-list"/);
  assert.match(html, /id="garage-equipment-load-more"/);
  assert.match(html, /id="garage-repair-button"/);
  assert.match(html, /id="garage-withdraw-button"/);
  assert.match(html, /id="garage-withdraw-all-button" class="garage-withdraw-all-button"/);
  assert.match(html, /id="garage-chest-list"/);
  assert.match(html, /id="garage-chest-dialog"/);
  assert.match(html, /id="garage-chest-dialog-outcomes"/);
  assert.match(source, /VIEW ODDS & EXACT STATS/);
  assert.match(source, /garageChestOutcomes\(product\)/);
  assert.match(source, /\['BANKED XP'/);
  assert.match(source, /\['NEXT LEVEL'/);
  assert.doesNotMatch(html, /id="select-loadout-button"[^>]*href=/);
  assert.match(source, /new NftGarageClient\(\{ wallet, api: apiClient \}\)/);
  assert.match(source, /No separate confirmation is needed/);
  assert.match(source, /returnToMinerAfterRun = resultScreenMode !== RUN_MODES\.PRACTICE/);
  assert.match(source, /void openMinerSelect\(\)/);
});

test('Practice is visibly public, rewardless, and starts without the authenticated NFT path', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const admin = await readFile(`${root}admin.html`, 'utf8');

  assert.match(html, /Anyone can play · No XP · No Crystals/);
  assert.match(html, /NO XP · NO CRYSTALS/);
  assert.match(html, /No wallet or Miner NFT needed/);
  assert.match(source, /PRACTICE · NO XP · NO CRYSTALS/);
  assert.match(source, /No XP, no MATT Crystals, and no leaderboard score/);
  const useServer = source.match(/const useServer\s*=([\s\S]*?);\s*activePracticeClaim/)?.[1] || '';
  assert.doesNotMatch(useServer, /RUN_MODES\.PRACTICE/);
  assert.match(source, /apiClient\.gameTuning\(mode\)/);
  assert.match(source, /apiClient\.mineSlot\(slotIdForMode\(mode\)\)/);
  assert.match(admin, /Practice is the public no-wallet demo and always awards zero XP and zero Crystals/);
});
