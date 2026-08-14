import { SERVER_RUN_MODES } from './constants.js';

export const PRACTICE_PLAY_POLICY = Object.freeze({
  public: true,
  walletRequired: false,
  minerRequired: false,
  xpEnabled: false,
  crystalsEnabled: false,
  label: 'ANYONE CAN PLAY · NO XP · NO CRYSTALS'
});

const NFT_REWARD_RUN_MODES = new Set([
  SERVER_RUN_MODES.PAID
]);

const RETIRED_RUN_MODES = new Set([
  SERVER_RUN_MODES.FREE,
  SERVER_RUN_MODES.WEEKLY,
  SERVER_RUN_MODES.ENDLESS
]);

export const MINER_GATED_MINE_IDS = Object.freeze(['arena', 'pass']);

export function requiresMinerNft(mode) {
  return NFT_REWARD_RUN_MODES.has(String(mode || '').toLowerCase());
}

export function requiresMinerNftForMine(mineId) {
  return MINER_GATED_MINE_IDS.includes(String(mineId || '').toLowerCase());
}

export function isRetiredRunMode(mode) {
  return RETIRED_RUN_MODES.has(String(mode || '').toLowerCase());
}
