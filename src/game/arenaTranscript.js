const ALLOWED_EVENT_TYPES = new Set(['input', 'command', 'finish']);
const MAX_BATCH_EVENTS = 256;
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([150, 400, 900]);
const DEFAULT_FINALIZATION_RETRY_DELAYS_MS = Object.freeze([
  250,
  500,
  1_000,
  2_000,
  3_000,
  5_000,
  8_000
]);

export class ArenaTranscript {
  constructor(api, run, options = {}) {
    this.api = api;
    this.runId = run.runId;
    this.runToken = run.runToken;
    this.checkpoint = run.checkpoint || null;
    this.nextSequence = Math.max(1, Number(this.checkpoint?.throughSeq || 0) + 1);
    this.pending = [];
    this.flushSize = Math.max(1, Math.min(
      MAX_BATCH_EVENTS,
      Math.floor(Number(options.flushSize || MAX_BATCH_EVENTS))
    ));
    this.appendEvents = options.appendEvents || ((...args) => this.api.appendArenaEvents(...args));
    this.retryDelays = Array.isArray(options.retryDelays)
      ? options.retryDelays.map((delay) => Math.max(0, Number(delay) || 0))
      : DEFAULT_RETRY_DELAYS_MS;
    this.wait = options.wait || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
    this.batches = [];
    this.drainPromise = null;
    this.fatalError = null;
    this.closed = false;
    this.lastInput = '';
  }

  record(event) {
    if (this.closed || !ALLOWED_EVENT_TYPES.has(event?.type)) return;
    const normalized = normalizeClientEvent(event);
    if (normalized.type === 'input') {
      const signature = JSON.stringify({
        moveX: normalized.moveX,
        moveY: normalized.moveY,
        aim: normalized.aim,
        attack: normalized.attack,
        dash: normalized.dash,
        weapon: normalized.weapon
      });
      if (signature === this.lastInput) return;
      this.lastInput = signature;
    }
    this.pending.push({ seq: this.nextSequence++, ...normalized });
    if (this.pending.length >= this.flushSize) {
      // A failed background flush remains queued for close() to retry. Avoid
      // turning a recoverable connection interruption into an unhandled
      // browser rejection.
      void this.flush().catch(() => undefined);
    }
  }

  flush() {
    if (this.pending.length) {
      this.batches.push(this.pending.splice(0, this.pending.length));
    }
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (!this.batches.length) {
      return this.drainPromise || Promise.resolve(this.checkpoint);
    }
    if (!this.drainPromise) {
      const work = this.#drainBatches();
      const settled = work.finally(() => {
        if (this.drainPromise === settled) this.drainPromise = null;
      });
      this.drainPromise = settled;
    }
    return this.drainPromise;
  }

  async close() {
    this.closed = true;
    try {
      return await this.#flushUntilEmpty();
    } catch (error) {
      // A background batch may have exhausted its short retry window just as
      // the run ended. Give retryable transport/server failures one final
      // ordered drain; validation failures remain immediate and final.
      if (!isRetryableAppendError(error)) throw error;
      return this.#flushUntilEmpty();
    }
  }

  async discard() {
    this.closed = true;
    this.pending = [];
    this.batches = [];
    try {
      await this.drainPromise;
    } catch {
      // A forfeited run can still close cleanly if an earlier transcript
      // write failed.
    }
  }

  async #drainBatches() {
    while (this.batches.length) {
      const events = this.batches[0];
      try {
        this.checkpoint = await this.#appendWithRetry(events);
      } catch (error) {
        if (!isRetryableAppendError(error)) this.fatalError = error;
        throw error;
      }
      this.batches.shift();
    }
    return this.checkpoint;
  }

  async #flushUntilEmpty() {
    do {
      await this.flush();
    } while (this.pending.length || this.batches.length);
    return this.checkpoint;
  }

  async #appendWithRetry(events) {
    let attempt = 0;
    while (true) {
      try {
        return await this.appendEvents(
          this.runId,
          this.runToken,
          this.checkpoint,
          events
        );
      } catch (error) {
        if (
          !isRetryableAppendError(error) ||
          attempt >= this.retryDelays.length
        ) {
          throw error;
        }
        await this.wait(this.retryDelays[attempt]);
        attempt += 1;
      }
    }
  }
}

function normalizeClientEvent(event) {
  const base = {
    tick: Math.max(0, Math.floor(Number(event.tick || 0))),
    type: event.type
  };
  if (event.type === 'input') {
    return {
      ...base,
      moveX: Math.max(-1_000, Math.min(1_000, Math.round(Number(event.moveX || 0)))),
      moveY: Math.max(-1_000, Math.min(1_000, Math.round(Number(event.moveY || 0)))),
      aim: event.aim === null ? null : Math.max(-31_416, Math.min(31_416, Math.round(Number(event.aim || 0)))),
      attack: event.attack === true,
      dash: event.dash === true,
      weapon: ['', 'pickaxe', 'dynamite', 'blaster'].includes(String(event.weapon || ''))
        ? String(event.weapon || '')
        : ''
    };
  }
  if (event.type === 'command') {
    return {
      ...base,
      command: String(event.command || ''),
      ...(event.value ? { value: String(event.value) } : {})
    };
  }
  return base;
}

function isRetryableAppendError(error) {
  const status = Number(error?.status);
  return status === 0 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500;
}

export async function retryRunFinalization(operation, options = {}) {
  if (typeof operation !== 'function') throw new TypeError('A run finalization function is required.');
  const delays = Array.isArray(options.retryDelays)
    ? options.retryDelays.map((delay) => Math.max(0, Number(delay) || 0))
    : DEFAULT_FINALIZATION_RETRY_DELAYS_MS;
  const wait = options.wait || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  const onRetry = typeof options.onRetry === 'function' ? options.onRetry : () => undefined;
  let attempt = 0;
  while (true) {
    try {
      return await operation(attempt + 1);
    } catch (error) {
      if (!isRetryableAppendError(error) || attempt >= delays.length) throw error;
      try {
        onRetry(error, {
          attempt: attempt + 1,
          nextAttempt: attempt + 2,
          delayMs: delays[attempt]
        });
      } catch {
        // UI reporting must not prevent a score-save retry.
      }
      await wait(delays[attempt]);
      attempt += 1;
    }
  }
}

export { ALLOWED_EVENT_TYPES, isRetryableAppendError };
