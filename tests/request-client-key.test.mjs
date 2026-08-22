import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createMattMineHttpServer } from '../server/http.js';
import { createProductionMattMineHttpServer } from '../server/production-http.js';
import { requestClientKey } from '../server/request-client-key.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function request(remoteAddress, forwardedFor = '') {
  return {
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
    socket: { remoteAddress }
  };
}

async function withTrustProxy(value, callback) {
  const previous = process.env.MATT_MINE_TRUST_PROXY;
  if (value) process.env.MATT_MINE_TRUST_PROXY = value;
  else delete process.env.MATT_MINE_TRUST_PROXY;
  try {
    await callback();
  } finally {
    if (previous === undefined) delete process.env.MATT_MINE_TRUST_PROXY;
    else process.env.MATT_MINE_TRUST_PROXY = previous;
  }
}

async function withServer(server, callback) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('untrusted deployments ignore a spoofable forwarded address', () => {
  assert.equal(
    requestClientKey(request('127.0.0.1', '203.0.113.20'), { trustProxy: '' }),
    '127.0.0.1'
  );
});

test('Render rate limiting uses the first forwarded client address', () => {
  const first = requestClientKey(
    request('10.0.0.5', '203.0.113.20, 10.0.0.5'),
    { trustProxy: 'render' }
  );
  const second = requestClientKey(
    request('10.0.0.5', '203.0.113.21, 10.0.0.5'),
    { trustProxy: 'render' }
  );
  assert.equal(first, '203.0.113.20');
  assert.equal(second, '203.0.113.21');
  assert.notEqual(first, second);
});

test('malformed forwarded addresses fall back to the connected peer', () => {
  assert.equal(
    requestClientKey(request('::ffff:192.0.2.10', 'not-an-ip'), { trustProxy: 'render' }),
    '192.0.2.10'
  );
});

test('the base HTTP limiter ignores forwarded clients until Render trust is explicit', async (context) => {
  context.mock.method(console, 'log', () => {});
  await withTrustProxy('', async () => {
    const server = createMattMineHttpServer({
      root: ROOT,
      service: { publicOrigin: null }
    });
    await withServer(server, async (baseUrl) => {
      for (let index = 0; index < 12; index += 1) {
        const response = await fetch(`${baseUrl}/api/auth/challenge`, {
          headers: { 'x-forwarded-for': `203.0.113.${index + 1}` }
        });
        assert.equal(response.status, 404);
      }
      const limited = await fetch(`${baseUrl}/api/auth/challenge`, {
        headers: { 'x-forwarded-for': '203.0.113.99' }
      });
      assert.equal(limited.status, 429);

      process.env.MATT_MINE_TRUST_PROXY = 'render';
      for (let index = 0; index < 13; index += 1) {
        const response = await fetch(`${baseUrl}/api/auth/challenge`, {
          headers: { 'x-forwarded-for': `198.51.100.${index + 1}, 10.0.0.5` }
        });
        assert.equal(response.status, 404);
      }
    });
  });
});

test('the production HTTP limiter uses Render first-forwarded clients', async (context) => {
  context.mock.method(console, 'log', () => {});
  await withTrustProxy('render', async () => {
    const server = createProductionMattMineHttpServer({
      root: ROOT,
      service: { publicOrigin: null }
    });
    await withServer(server, async (baseUrl) => {
      for (let index = 0; index < 31; index += 1) {
        const response = await fetch(`${baseUrl}/api/expansion/status`, {
          method: 'DELETE',
          headers: { 'x-forwarded-for': `198.51.100.${index + 1}, 10.0.0.5` }
        });
        assert.equal(response.status, 405);
      }

      for (let index = 0; index < 30; index += 1) {
        const response = await fetch(`${baseUrl}/api/expansion/status`, {
          method: 'DELETE',
          headers: { 'x-forwarded-for': '203.0.113.200, 10.0.0.5' }
        });
        assert.equal(response.status, 405);
      }
      const limited = await fetch(`${baseUrl}/api/expansion/status`, {
        method: 'DELETE',
        headers: { 'x-forwarded-for': '203.0.113.200, 10.0.0.5' }
      });
      assert.equal(limited.status, 429);
    });
  });
});
