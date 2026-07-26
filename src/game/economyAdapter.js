/**
 * Local adapter used by v0.4. Production will replace these methods with
 * wallet transactions plus server-authoritative entitlements and scores.
 */
export class LocalEconomyAdapter {
  constructor(store) {
    this.store = store;
  }

  snapshot() {
    return structuredClone(this.store.state);
  }

  async connect() {
    return { walletId: this.store.state.walletId, network: 'local-test', connected: true };
  }

  async submitMockTransaction(result) {
    if (!result.ok) throw new Error(result.error);
    this.store.save(result.state);
    return { status: 'confirmed', testMode: true, result };
  }
}
