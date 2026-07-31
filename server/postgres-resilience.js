const TRANSIENT_POSTGRES_CODES = new Set([
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
  '08007',
  '08P01',
  'ECONNRESET',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'EAI_AGAIN'
]);

const TRANSIENT_POSTGRES_MESSAGES = [
  'connection terminated unexpectedly',
  'connection terminated',
  'connection reset by peer',
  'database system is in recovery mode',
  'database system is starting up',
  'the database system is shutting down',
  'terminating connection due to administrator command',
  'server closed the connection unexpectedly',
  'ssl connection has been closed unexpectedly',
  'socket hang up',
  'timeout expired'
];

export function isTransientPostgresError(error) {
  let current = error;
  const visited = new Set();
  while (current && !visited.has(current)) {
    visited.add(current);
    const code = String(current.code || '').toUpperCase();
    if (TRANSIENT_POSTGRES_CODES.has(code) || code.startsWith('08')) return true;
    const message = String(current.message || current).toLowerCase();
    if (TRANSIENT_POSTGRES_MESSAGES.some((candidate) => message.includes(candidate))) return true;
    current = current.cause;
  }
  return false;
}

export async function retryTransientPostgres(operation, options = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('A PostgreSQL operation function is required.');
  }
  const maxAttempts = positiveInteger(options.maxAttempts, 5);
  const baseDelayMs = nonNegativeInteger(options.baseDelayMs, 100);
  const maxDelayMs = positiveInteger(options.maxDelayMs, 2_000);
  const sleep = typeof options.sleep === 'function' ? options.sleep : wait;
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : () => undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (!isTransientPostgresError(error) || attempt >= maxAttempts) throw error;
      const delayMs = Math.min(maxDelayMs, baseDelayMs * (2 ** (attempt - 1)));
      try {
        onRetry(error, { attempt, nextAttempt: attempt + 1, maxAttempts, delayMs });
      } catch {
        // Diagnostics must not prevent a recovery attempt.
      }
      await sleep(delayMs);
    }
  }
  throw new Error('PostgreSQL retry loop ended unexpectedly.');
}

export function guardPostgresPool(pool, options = {}) {
  if (!pool) throw new TypeError('A PostgreSQL pool is required.');
  const report = typeof options.onError === 'function' ? options.onError : () => undefined;
  const guardedClients = new Map();
  const reportedErrors = new WeakSet();

  const reportOnce = (error, source) => {
    if (error && typeof error === 'object') {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    try {
      report(error, source);
    } catch {
      // Logging and telemetry are never allowed to crash the service.
    }
  };

  const guardClient = (client) => {
    if (!client?.on || guardedClients.has(client)) return client;
    const errorListener = (error) => reportOnce(error, 'client');
    const endListener = () => {
      client.off?.('error', errorListener);
      client.off?.('end', endListener);
      guardedClients.delete(client);
    };
    client.on('error', errorListener);
    client.once?.('end', endListener);
    guardedClients.set(client, { errorListener, endListener });
    return client;
  };

  const poolErrorListener = (error, client) => {
    guardClient(client);
    reportOnce(error, 'pool');
  };
  const poolConnectListener = (client) => guardClient(client);
  pool.on?.('error', poolErrorListener);
  pool.on?.('connect', poolConnectListener);

  return {
    guardClient,
    close() {
      pool.off?.('error', poolErrorListener);
      pool.off?.('connect', poolConnectListener);
      for (const [client, listeners] of guardedClients) {
        client.off?.('error', listeners.errorListener);
        client.off?.('end', listeners.endListener);
      }
      guardedClients.clear();
    }
  };
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
