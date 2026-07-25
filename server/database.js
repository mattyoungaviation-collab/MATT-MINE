import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { defaultServerState, normalizeServerState } from './state.js';

export class MemoryDatabase {
  constructor(initialState = defaultServerState()) {
    this.state = normalizeServerState(initialState);
    this.queue = Promise.resolve();
  }

  async init() {
    return this;
  }

  async read() {
    await this.queue;
    return structuredClone(this.state);
  }

  async transact(mutator) {
    const operation = this.queue.then(async () => {
      const draft = structuredClone(this.state);
      const result = await mutator(draft);
      this.state = normalizeServerState(draft);
      await this.persist();
      return structuredClone(result);
    });
    this.queue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async persist() {}
}

export class JsonFileDatabase extends MemoryDatabase {
  constructor(filePath, options = {}) {
    super(options.initialState);
    this.filePath = filePath;
    this.now = options.now || Date.now;
    this.initialized = false;
    this.recoveredFile = null;
  }

  async init() {
    if (this.initialized) return this;
    await mkdir(dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, 'utf8');
      this.state = normalizeServerState(JSON.parse(raw));
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        this.recoveredFile = `${this.filePath}.corrupt-${this.now()}`;
        await rename(this.filePath, this.recoveredFile).catch(() => undefined);
      }
      this.state = defaultServerState();
      await this.persist();
    }
    this.initialized = true;
    return this;
  }

  async read() {
    await this.init();
    return super.read();
  }

  async transact(mutator) {
    await this.init();
    return super.transact(mutator);
  }

  async persist() {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }
}
