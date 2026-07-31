export const RONIN_CHAINS = Object.freeze({
  MAINNET: 2020
});

export const AUTH_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
export const RUN_TTL_MS = 45 * 60 * 1000;
export const PRACTICE_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_RANKED_RUN_WINDOW_MS = 5 * 60 * 1000;
export const MAX_REQUEST_BYTES = 96 * 1024;
export const MAX_RUN_SCORE = 5_000_000;
export const SERVER_STATE_VERSION = 16;
export const MATT_TOKEN_DECIMALS = 18;
export const HARD_MAX_BOARD_MATT = 5_000_000;

export const SERVER_RUN_MODES = Object.freeze({
  FREE: 'free',
  PAID: 'paid',
  PRACTICE: 'practice',
  BETA: 'beta',
  WEEKLY: 'weekly',
  ENDLESS: 'endless'
});
