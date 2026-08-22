import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the wallet Crystal Bank stays usable without a selected Miner and exposes live UTC limits', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const walletBankIndex = html.indexOf('id="wallet-crystal-bank"');
  const minerCommandCenterIndex = html.indexOf('id="miner-command-center"');

  assert.ok(walletBankIndex > 0 && walletBankIndex < minerCommandCenterIndex);
  assert.match(html, /id="garage-crystal-withdrawable"/);
  assert.match(html, /id="garage-crystal-wallet-remaining"/);
  assert.match(html, /id="garage-crystal-reset"/);
  assert.match(html, /id="garage-crystal-state"/);
  assert.match(html, /id="garage-crystal-receipt"/);
  assert.match(source, /nftGarage\.walletSnapshot\(\{ address: serverPlayer\.address \}\)/);
  assert.match(source, /formatGarageTokenUnits\(availability\.withdrawableRaw, 18, 18\)/);
});

test('Arena applies and renders the accepted NFT settlement before refreshing Miner state', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const start = source.indexOf('async function submitArenaRun');
  const end = source.indexOf('function showFinalizationBusy', start);
  const arenaSubmission = source.slice(start, end);

  assert.match(arenaSubmission, /applyAcceptedNftSettlement\(accepted\)/);
  assert.match(arenaSubmission, /nftSettlementMarkup\(nftSettlement\)/);
  assert.match(arenaSubmission, /if \(nftSettlement\) await refreshServerPlayer\(\)/);
});

test('already-settled retries render a confirmation instead of NaN reward values', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const start = source.indexOf('function nftSettlementMarkup');
  const end = source.indexOf('async function submitServerRun', start);
  const settlementMarkup = source.slice(start, end);

  assert.match(settlementMarkup, /settlement\.crystalsBanked != null/);
  assert.match(settlementMarkup, /Number\.isFinite\(crystalsBanked\)/);
  assert.match(settlementMarkup, /ON-CHAIN SETTLEMENT ALREADY CONFIRMED/);
  assert.doesNotMatch(settlementMarkup, /formatNumber\(settlement\.crystalsBanked\)/);
  assert.doesNotMatch(settlementMarkup, /formatNumber\(settlement\.xpBanked\)/);
});

test('locked-run recovery is explicitly a forfeit and never claims a true resume', async () => {
  const html = await readFile(`${root}index.html`, 'utf8');
  const source = await readFile(`${root}src/main.js`, 'utf8');

  assert.match(html, /This old run cannot be resumed/);
  assert.match(html, /FORFEIT OLD RUN/);
  assert.match(source, /This does not resume the run/);
  assert.match(source, /on-chain death rules/);
  assert.doesNotMatch(source, /Resume safely from Phase 1|RESUME MINER RUN/);
});

test('rewarded runs warn before unload and mine intent survives a refresh', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');

  assert.match(source, /matt-mine:pending-mine-destination/);
  assert.match(source, /let pendingMineDestination = restoredPendingMineDestination\(\)/);
  assert.match(source, /rememberPendingMineDestination\(destination\)/);
  assert.match(source, /serverPlayer && pendingMineDestination\) await openMinerSelect\(\)/);
  assert.match(source, /window\.addEventListener\('beforeunload',[\s\S]*?!activeServerRun && !activeArenaRun[\s\S]*?event\.returnValue = ''/);
});
