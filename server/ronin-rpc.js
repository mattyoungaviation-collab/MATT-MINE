import { createPublicClient, custom } from 'viem';
import { ronin } from 'viem/chains';

const SAFE_READS = new Set([
  'eth_blockNumber', 'eth_call', 'eth_chainId', 'eth_getBalance', 'eth_getBlockByHash',
  'eth_getBlockByNumber', 'eth_getCode', 'eth_getLogs', 'eth_getTransactionByHash',
  'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_getStorageAt',
  'eth_maxPriorityFeePerGas', 'eth_gasPrice', 'net_version'
]);

export class RoninRpcPool {
  constructor(options = {}) {
    const configured = Array.isArray(options.urls) ? options.urls : String(options.urls || '').split(',');
    this.endpoints = [...new Set(configured.map((value) => String(value).trim()).filter(Boolean))]
      .map((url, index) => ({ url, order: index, failures: 0, successes: 0, openUntil: 0, latencyMs: null, lastError: '' }));
    if (!this.endpoints.length) this.endpoints.push({ url: 'https://api.roninchain.com/rpc', order: 0, failures: 0, successes: 0, openUntil: 0, latencyMs: null, lastError: '' });
    this.timeoutMs = positive(options.timeoutMs, 10_000);
    this.breakAfter = positive(options.breakAfter, 3);
    this.cooldownMs = positive(options.cooldownMs, 30_000);
    this.fetch = options.fetch || globalThis.fetch;
    this.sequence = 0;
  }

  async request({ method, params = [] }) {
    if (!SAFE_READS.has(method)) throw rpcError('rpc_unsafe_method_refused', `RPC method ${method} is not an approved safe read.`);
    const now = Date.now();
    const candidates = this.endpoints
      .filter((endpoint) => endpoint.openUntil <= now)
      .sort((left, right) => left.order - right.order || left.failures - right.failures);
    if (!candidates.length) throw rpcError('ronin_rpc_unavailable', 'All configured Ronin RPC circuits are open.');
    let lastError;
    for (const endpoint of candidates) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      const startedAt = Date.now();
      try {
        const response = await this.fetch(endpoint.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: ++this.sequence, method, params }),
          signal: controller.signal
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json();
        if (body.error) {
          const error = new Error(body.error.message || 'RPC response error');
          error.rpcCode = body.error.code;
          // Deterministic node responses are not endpoint-health failures.
          throw Object.assign(error, { deterministicRpcError: true });
        }
        endpoint.successes += 1;
        endpoint.failures = 0;
        endpoint.latencyMs = Date.now() - startedAt;
        endpoint.lastError = '';
        return body.result;
      } catch (error) {
        lastError = error;
        if (error?.deterministicRpcError) throw error;
        endpoint.failures += 1;
        endpoint.lastError = String(error?.message || error).slice(0, 160);
        if (endpoint.failures >= this.breakAfter) endpoint.openUntil = Date.now() + this.cooldownMs;
      } finally {
        clearTimeout(timer);
      }
    }
    throw rpcError('ronin_rpc_unavailable', 'Ronin RPC reads are temporarily unavailable.', lastError);
  }

  health() {
    return {
      ok: this.endpoints.some((endpoint) => endpoint.openUntil <= Date.now()),
      endpoints: this.endpoints.map(({ url, order, failures, successes, openUntil, latencyMs, lastError }) => ({
        url: redactUrl(url), order, failures, successes, openUntil, latencyMs, lastError
      }))
    };
  }
}

export function createRoninReadClient(options = {}) {
  const pool = options.pool || new RoninRpcPool(options);
  return { client: createPublicClient({ chain: ronin, transport: custom(pool) }), pool };
}

function positive(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return 'configured-endpoint';
  }
}

function rpcError(code, message, cause) {
  return Object.assign(new Error(message), { code, cause, infrastructureUnavailable: true });
}
