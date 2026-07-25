/**
 * Standalone test adapter.
 *
 * During the MATT Token Live merge, replace this module with the existing
 * wallet/session service. The game only needs a stable player id and a method
 * that can confirm ownership or payment outside the gameplay loop.
 */
export const walletAdapter = {
  mode: 'local-test',
  async getPlayer() {
    return { id: 'local-test-player', displayName: 'Test Miner', connected: false };
  },
  async connect() {
    throw new Error('Wallet connection is disabled in the standalone test build.');
  }
};
