import { createHash, randomUUID } from 'node:crypto';

const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{8,100}$/;

export function observeHttpRequest(request, response) {
  const supplied = String(request.headers['x-request-id'] || '');
  const requestId = SAFE_REQUEST_ID.test(supplied) ? supplied : randomUUID();
  const startedAt = performance.now();
  request.requestId = requestId;
  response.setHeader('X-Request-Id', requestId);
  response.once('finish', () => {
    const url = new URL(request.url || '/', 'http://matt-mine.invalid');
    const event = {
      timestamp: new Date().toISOString(),
      level: response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info',
      event: 'http_request',
      requestId,
      method: request.method || 'GET',
      path: url.pathname,
      status: response.statusCode,
      durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      client: safeIdentifier(request.socket.remoteAddress || 'unknown')
    };
    // Never log request bodies, cookies, Authorization, signatures, or keys.
    console.log(JSON.stringify(event));
  });
  return requestId;
}

export function safeIdentifier(value) {
  return createHash('sha256').update(String(value).toLowerCase()).digest('hex').slice(0, 16);
}
