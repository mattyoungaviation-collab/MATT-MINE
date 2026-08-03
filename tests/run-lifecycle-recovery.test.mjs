import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

test('client cleanup releases server runs after launch, replay, and runtime failures', async () => {
  const source = await readFile(`${ROOT}src/main.js`, 'utf8');

  assert.match(source, /if \(issuedRun\) await releaseIssuedServerRun\(issuedRun, issuedTranscript\)/);
  assert.match(source, /await releaseIssuedServerRun\(serverRun, transcript\)/);
  assert.match(source, /onFatalError\(error\)[\s\S]*abandonIssuedRun\(\{ mode: failedMode, reason: 'client_runtime_error' \}\)/);
  assert.match(source, /function abandonIssuedRun[\s\S]*retryRunFinalization\([\s\S]*apiClient\.abandonRun\(serverRun\.runId, serverRun\.runToken\)/);
  assert.match(source, /async function releaseIssuedServerRun[\s\S]*retryRunFinalization\([\s\S]*apiClient\.abandonRun\(serverRun\.runId, serverRun\.runToken\)/);
});
