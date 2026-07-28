import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('the revive button never silently ignores an offered revive', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const start = source.indexOf('async function purchasePaidRevive()');
  const end = source.indexOf('\nfunction declinePaidRevive()', start);
  const handler = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.doesNotMatch(handler, /if\s*\(!paidRevivePending\s*\|\|[^)]*activeServerRun[^)]*\)\s*return/);
  assert.match(handler, /This revive offer is no longer active/);
  assert.match(handler, /REVIVE UNAVAILABLE/);
  assert.match(handler, /RONIN CONFIRMATION REQUIRED/);
  assert.match(handler, /RETRY CONFIRMATION/);
});

test('a broadcast revive payment is retained for confirmation instead of being cancelled', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const start = source.indexOf('async function purchasePaidRevive()');
  const end = source.indexOf('\nfunction declinePaidRevive()', start);
  const handler = source.slice(start, end);

  assert.match(handler, /onBroadcast\(transactionHash\)\s*\{\s*context\.transactionHash = transactionHash;/);
  assert.match(handler, /if\s*\(serverPending && !context\.transactionHash\)/);
  assert.match(handler, /Confirmation can be retried without paying again/);
});

test('each new revive offer resets the persisted button and captures its verified run session', async () => {
  const source = await readFile(`${root}src/main.js`, 'utf8');
  const start = source.indexOf('onPaidReviveOffered(data)');
  const end = source.indexOf('\n  onPaidReviveApplied()', start);
  const hook = source.slice(start, end);

  assert.match(hook, /paidReviveContext = activeServerRun && activeArenaTranscript/);
  assert.match(hook, /reviveButton\.disabled = !paidReviveContext/);
  assert.match(hook, /reviveButton\.textContent = paidReviveContext \? 'REVIVE WITH RON' : 'REVIVE UNAVAILABLE'/);
});
