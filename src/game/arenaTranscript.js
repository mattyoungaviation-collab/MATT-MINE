const ALLOWED_EVENT_TYPES = new Set([
  'ore_broken',
  'enemy_killed',
  'damage_taken',
  'guardian_defeated',
  'descend',
  'extract',
  'knockout'
]);

export class ArenaTranscript {
  constructor(api, run, options = {}) {
    this.api = api;
    this.runId = run.runId;
    this.runToken = run.runToken;
    this.checkpoint = run.checkpoint || null;
    this.nextSequence = Math.max(1, Number(this.checkpoint?.throughSeq || 0) + 1);
    this.pending = [];
    this.flushSize = Math.max(1, Number(options.flushSize || 8));
    this.queue = Promise.resolve();
    this.closed = false;
  }

  record(event) {
    if (this.closed || !ALLOWED_EVENT_TYPES.has(event?.type)) return;
    const targetId = Number(event.targetId);
    const amount = Number(event.amount);
    this.pending.push({
      seq: this.nextSequence++,
      tick: Math.max(0, Math.floor(Number(event.tick || 0))),
      type: event.type,
      ...(Number.isSafeInteger(targetId) && targetId > 0 ? { targetId } : {}),
      ...(Number.isFinite(amount) && amount >= 0 ? { amount: Math.round(amount * 1_000) / 1_000 } : {})
    });
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
}

export { ALLOWED_EVENT_TYPES };
