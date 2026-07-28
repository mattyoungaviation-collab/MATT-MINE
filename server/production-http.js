import http from 'node:http';
import { MAX_REQUEST_BYTES } from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { normalizeOrigin } from './auth-message.js';
import { createMattMineHttpServer } from './http.js';

const ECONOMY_PATHS = new Set([
  '/api/nuggets/status',
  '/api/nuggets/purchases/quote',
  '/api/nuggets/purchases/confirm',
  '/api/nuggets/practice/quote',
  '/api/admin/nugget-economy'
]);

export function createProductionMattMineHttpServer({ root, service, maxRequestBytes = MAX_REQUEST_BYTES }) {
  const baseServer = createMattMineHttpServer({ root, service, maxRequestBytes });
  const baseHandler = baseServer.listeners('request')[0];
  const limiter = createRateLimiter();

  return http.createServer(async (request, response) => {
    const requestUrl = new URL(request.url || '/', requestOrigin(request, service.publicOrigin));
    if (!ECONOMY_PATHS.has(requestUrl.pathname)) {
      baseHandler(request, response);
      return;
    }

    applySecurityHeaders(response);
    try {
      enforceSameOrigin(request, service.publicOrigin);
      const clientKey = request.socket.remoteAddress || 'unknown';
      limiter.consume(`${clientKey}:${requestUrl.pathname}`, 30, 60_000);
      const method = request.method || 'GET';
      const path = requestUrl.pathname;

      if (method === 'GET' && path === '/api/nuggets/status') {
        const result = await service.nuggetEconomyStatus(bearerToken(request));
        sendJson(response, 200, { ok: true, economy: result });
        return;
      }
      if (method === 'POST' && path === '/api/nuggets/purchases/quote') {
        const body = await readJson(request, maxRequestBytes);
        const result = await service.quoteNuggetPurchase(bearerToken(request), body);
        sendJson(response, 201, { ok: true, ...result });
        return;
      }
      if (method === 'POST' && path === '/api/nuggets/purchases/confirm') {
        const body = await readJson(request, maxRequestBytes);
        const result = await service.confirmNuggetPurchase(bearerToken(request), body);
        sendJson(response, 200, { ok: true, ...result });
        return;
      }
      if (method === 'POST' && path === '/api/nuggets/practice/quote') {
        const body = await readJson(request, maxRequestBytes);
        const result = await service.quotePracticeClaim(bearerToken(request), body);
        sendJson(response, 201, { ok: true, ...result });
        return;
      }
      if (method === 'GET' && path === '/api/admin/nugget-economy') {
        const result = await service.adminNuggetEconomy(request.headers['x-matt-admin-key']);
        sendJson(response, 200, { ok: true, economy: result });
        return;
      }
      if (method === 'PUT' && path === '/api/admin/nugget-economy') {
        const body = await readJson(request, maxRequestBytes);
        const result = await service.updateAdminNuggetEconomy(
          request.headers['x-matt-admin-key'],
          body.patch,
          body.reason
        );
        sendJson(response, 200, { ok: true, economy: result });
        return;
      }
      throw new ApiError(405, 'method_not_allowed', 'That nugget economy route does not support this method.');
    } catch (error) {
      sendError(response, error);
    }
  });
}

function requestOrigin(request, configuredOrigin) {
  if (configuredOrigin) return normalizeOrigin(configuredOrigin);
  const host = request.headers.host;
  assertApi(typeof host === 'string' && host.length > 0, 400, 'host_required', 'The HTTP Host header is required.');
  const forwardedProtocol = String(request.headers['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  return normalizeOrigin(`${forwardedProtocol === 'https' ? 'https' : 'http'}://${host}`);
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
  if (!(error instanceof ApiError)) console.error('[MATT Mine nugget economy]', error);
  sendJson(response, status, {
    ok: false,
    error: { code, message, ...(error?.details ? { details: error.details } : {}) }
  });
}

function applySecurityHeaders(response) {
  response.setHeader('x-content-type-options', 'nosniff');
  response.setHeader('referrer-policy', 'same-origin');
  response.setHeader('x-frame-options', 'DENY');
  response.setHeader('cross-origin-opener-policy', 'same-origin');
  response.setHeader('cross-origin-resource-policy', 'same-origin');
  response.setHeader('strict-transport-security', 'max-age=31536000; includeSubDomains');
  response.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
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
    }
  };
}
