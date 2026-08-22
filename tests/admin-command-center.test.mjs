import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Admin command center exposes only controls backed by active game systems', async () => {
  const [html, script, registry] = await Promise.all([
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/admin.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/adminControlRegistry.js', import.meta.url), 'utf8')
  ]);

  const source = `${html}\n${script}\n${registry}`;
  assert.doesNotMatch(source, /nugget|permanent.?upgrade/i);
  assert.match(html, /Game Balance/i);
  assert.match(html, /Mine Operations/i);
  assert.match(script, /game-tuning/);
  assert.match(html, /id="nft-v2-map-current"/);
  assert.match(html, /id="nft-v2-economy-validation"/);
  assert.match(registry, /nft-v2:maps/);
  assert.match(registry, /nft-v2:phase-xp/);
  assert.doesNotMatch(script, /nft-v2-retire-version'\)\.value\s*=\s*result\.versionId/);
});

test('Admin page element identifiers remain unique', async () => {
  const html = await readFile(new URL('../admin.html', import.meta.url), 'utf8');
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});
