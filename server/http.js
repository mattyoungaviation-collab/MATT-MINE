import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { MAX_REQUEST_BYTES } from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { normalizeOrigin } from './auth-message.js';

const MIME_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
});

export function createMattMineHttpServer({ root, service, maxRequestBytes = MAX_REQUEST_BYTES }) {
  const staticRoot = resolve(root);
  const rateLimiter = createRateLimiter();

  return http.createServer(async (request, response) => {
    applySecurityHeaders(response);
    try {
      const requestUrl = new URL(request.url || '/', requestOrigin(request, service.publicOrigin));
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApiRequest({
          request,
          response,
          requestUrl,
          service,
          rateLimiter,
          maxRequestBytes
        });
        return;
      }
      await serveStatic(request, response, requestUrl.pathname, staticRoot);
    } catch (error) {
      sendError(response, error);
    }
  });
}

async function handleApiRequest({
  request,
  response,
  requestUrl,
  service,
  rateLimiter,
  maxRequestBytes
}) {
  const clientKey = request.socket.remoteAddress || 'unknown';
  const stricter = requestUrl.pathname === '/api/auth/challenge';
  rateLimiter.consume(`${clientKey}:${stricter ? 'challenge' : 'api'}`, stricter ? 12 : 240, stricter ? 10 * 60_000 : 60_000);
  enforceSameOrigin(request, service.publicOrigin);

  const method = request.method || 'GET';
  const path = requestUrl.pathname;
  if (method === 'GET' && path === '/api/health') {
    sendJson(response, 200, { ok: true, service: 'matt-mine', version: 9 });
    return;
  }
  if (method === 'GET' && path === '/api/config') {
    sendJson(response, 200, { ok: true, config: service.config() });
    return;
  }
  if (method === 'POST' && path === '/api/auth/challenge') {
    const body = await readJson(request, maxRequestBytes);
    const expectedOrigin = requestOrigin(request, service.publicOrigin);
    assertApi(normalizeOrigin(body.origin) === expectedOrigin, 403, 'origin_mismatch', 'The browser origin does not match this MATT Mine server.');
    const challenge = await service.createChallenge({
      address: body.address,
      chainId: body.chainId,
      origin: expectedOrigin
    });
    sendJson(response, 201, { ok: true, challenge });
    return;
  }
  if (method === 'POST' && path === '/api/auth/verify') {
    const body = await readJson(request, maxRequestBytes);
    const session = await service.verifyChallenge(body);
    sendJson(response, 200, { ok: true, session });
    return;
  }
  if (method === 'POST' && path === '/api/auth/logout') {
    const result = await service.signOut(bearerToken(request));
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/me') {
    const player = await service.me(bearerToken(request));
    sendJson(response, 200, { ok: true, player });
    return;
  }
  if (method === 'GET' && path === '/api/payments/status') {
    const status = await service.paymentStatus(bearerToken(request));
    sendJson(response, 200, { ok: true, status });
    return;
  }
  if (method === 'POST' && path === '/api/payments/paid-run/quote') {
    await readJson(request, maxRequestBytes);
    const quote = await service.quotePaidRun(bearerToken(request));
    sendJson(response, 200, { ok: true, quote });
    return;
  }
  if (method === 'POST' && path === '/api/payments/paid-run/confirm') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.confirmPaidRunPurchase(bearerToken(request), body.transactionHash);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'POST' && path === '/api/runs/start') {
    const body = await readJson(request, maxRequestBytes);
    const run = await service.startRun(bearerToken(request), body.mode);
    sendJson(response, 201, { ok: true, run });
    return;
  }
  if (method === 'POST' && path === '/api/runs/finish') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.finishRun(bearerToken(request), body);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }
  if (method === 'GET' && path === '/api/leaderboards') {
    const result = await service.leaderboard(bearerToken(request), requestUrl.searchParams.get('mode'));
    sendJson(response, 200, { ok: true, leaderboard: result });
    return;
  }
  if (method === 'POST' && path === '/api/profile/upgrades') {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.purchaseUpgrade(bearerToken(request), body.upgradeId);
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  const suspensionMatch = path.match(/^\/api\/admin\/wallets\/(0x[a-fA-F0-9]{40})\/suspension$/);
  if (method === 'PUT' && suspensionMatch) {
    const body = await readJson(request, maxRequestBytes);
    const result = await service.setWalletSuspension(
      request.headers['x-matt-admin-key'],
      suspensionMatch[1],
      body.suspended
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  throw new ApiError(404, 'api_not_found', 'The requested API route does not exist.');
}

async function serveStatic(request, response, pathname, root) {
  assertApi(['GET', 'HEAD'].includes(request.method || 'GET'), 405, 'method_not_allowed', 'Static files only support GET and HEAD.');
  const decoded = decodeURIComponent(pathname);
  assertApi(!decoded.includes('\0'), 400, 'invalid_path', 'The requested path is invalid.');
  const requestedPath = decoded === '/' ? 'index.html' : decoded.replace(/^[/\\]+/, '');
  let filePath = resolve(root, requestedPath);
  const rootRelativePath = relative(root, filePath);
  assertApi(
    rootRelativePath !== '..' && !rootRelativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(rootRelativePath),
    403,
    'path_forbidden',
    'The requested path is outside the application root.'
  );
  const info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) filePath = resolve(filePath, 'index.html');
  const body = await readFile(filePath).catch(() => null);
  assertApi(body, 404, 'file_not_found', 'Not found.');
  response.writeHead(200, {
    'content-type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
    'cache-control': 'no-store'
  });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function requestOrigin(request, configuredOrigin) {
  if (configuredOrigin) return normalizeOrigin(configuredOrigin);
  const host = request.headers.host;
  assertApi(typeof host === 'string' && host.length > 0, 400, 'host_required', 'The HTTP Host header is required.');
  return normalizeOrigin(`http://${host}`);
}

function enforceSameOrigin(request, configuredOrigin) {
  const originHeader = request.headers.origin;
  if (!originHeader) return;
  const expected = requestOrigin(request, configuredOrigin);
  assertApi(normalizeOrigin(originHeader) === expected, 403, 'cross_origin_rejected', 'Cross-origin API requests are not allowed.');
}

function bearerToken(request) {
  const authorization = request.headers.authorization;
  assertApi(typeof authorization === 'string' && authorization.startsWith('Bearer '), 401, 'authorization_required', 'A wallet session is required.');
  return authorization.slice('Bearer '.length);
}

async function readJson(request, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    assertApi(size <= maxBytes, 413, 'request_too_large', 'The request body is too large.');
    chunks.push(chunk);
  }
  assertApi(chunks.length > 0, 400, 'json_required', 'A JSON request body is required.');
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assertApi(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 400, 'json_object_required', 'The JSON body must be an object.');
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

function sendError(response, error) {
  if (response.headersSent) {
    response.end();
    return;
  }
  const status = error instanceof ApiError ? error.status : 500;
  const code = error instanceof ApiError ? error.code : 'internal_error';
  const message = error instanceof ApiError ? error.message : 'The MATT Mine server encountered an unexpected error.';
  if (!(error instanceof ApiError)) console.error('[MATT Mine server]', error);
  sendJson(response, status, {
    ok: false,
    error: { code, message, ...(error?.details ? { details: error.details } : {}) }
  });
}

function applySecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'same-origin');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
  );
}

function createRateLimiter() {
  const buckets = new Map();
  return {
    consume(key, limit, windowMs) {
      const timestamp = Date.now();
      const current = buckets.get(key);
      if (!current || current.resetsAt <= timestamp) {
        buckets.set(key, { count: 1, resetsAt: timestamp + windowMs });
        return;
      }
      assertApi(current.count < limit, 429, 'rate_limited', 'Too many requests. Try again shortly.');
      current.count += 1;
      if (buckets.size > 5_000) {
        for (const [bucketKey, bucket] of buckets) {
          if (bucket.resetsAt <= timestamp) buckets.delete(bucketKey);
        }
      }
    }
  };
}
