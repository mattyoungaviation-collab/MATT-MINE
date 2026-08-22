import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMattMineHttpServer } from '../server/http.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

test('the production static server never publishes legal Markdown drafts', async (context) => {
  const server = createMattMineHttpServer({
    root: ROOT,
    service: { publicOrigin: null }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const terms = await fetch(`${baseUrl}/legal/terms-of-service.md`);
  const disclosure = await fetch(`${baseUrl}/legal/nft-token-disclosures.md`);
  const publicRules = await fetch(`${baseUrl}/legal/matt-mine-arena-rules-v0.01.txt`);

  assert.equal(terms.status, 404);
  assert.equal(disclosure.status, 404);
  assert.equal(publicRules.status, 200);
});
