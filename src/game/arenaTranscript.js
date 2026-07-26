const ALLOWED_EVENT_TYPES = new Set(['input', 'command', 'finish']);

export class ArenaTranscript {
  constructor(api, run, options = {}) {
    this.api = api;
    this.runId = run.runId;
    this.runToken = run.runToken;
    this.checkpoint = run.checkpoint || null;
    this.nextSequence = Math.max(1, Number(this.checkpoint?.throughSeq || 0) + 1);
    this.pending = [];
    this.flushSize = Math.max(1, Number(options.flushSize || 64));
    this.queue = Promise.resolve();
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
    if (this.pending.length >= this.flushSize) void this.flush();
  }

  flush() {
    if (!this.pending.length) return this.queue.then(() => this.checkpoint);
    const events = this.pending.splice(0, this.pending.length);
    this.queue = this.queue.then(async () => {
      this.checkpoint = await this.api.appendArenaEvents(
        this.runId,
        this.runToken,
        this.checkpoint,
        events
      );
      return this.checkpoint;
    });
    return this.queue;
  }

  async close() {
    this.closed = true;
    return this.flush();
  }

  async discard() {
    this.closed = true;
    this.pending = [];
    try {
      await this.queue;
    } catch {
      // A forfeited run can still close cleanly if an earlier transcript
      // write failed.
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

export { ALLOWED_EVENT_TYPES };
