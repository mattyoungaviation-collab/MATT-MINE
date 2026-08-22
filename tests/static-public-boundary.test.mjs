import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createMattMineHttpServer } from '../server/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('production static routing serves only the explicit public application surface', async (context) => {
  const server = createMattMineHttpServer({
    root: ROOT,
    service: {
      publicOrigin: null,
      appVersion: 'test',
      buildCommit: 'test'
    }
  });
  await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
  context.after(() => new Promise((resolveClose) => server.close(resolveClose)));
  const origin = `http://127.0.0.1:${server.address().port}`;

  for (const pathname of [
    '/',
    '/admin.html',
    '/src/main.js',
    '/assets/favicon.svg',
    '/legal/matt-mine-arena-rules-v0.01.txt'
  ]) {
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 200, `${pathname} should remain public`);
  }

  for (const pathname of [
    '/.env.example',
    '/package.json',
    '/render.yaml',
    '/server/http.js',
    '/contracts/deployments/nft-v2-ronin.json',
    '/assets/nft/layer-manifest.json',
    '/legal/terms-of-service.md'
  ]) {
    const response = await fetch(`${origin}${pathname}`);
    assert.equal(response.status, 404, `${pathname} must not be publicly downloadable`);
  }
});
