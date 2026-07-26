import { getAddress } from 'viem';
import {
  HARD_MAX_BOARD_MATT,
  MATT_TOKEN_DECIMALS,
  SERVER_RUN_MODES
} from './constants.js';
import { ApiError, assertApi } from './errors.js';
import { createStandardMerkleTree } from './merkle.js';

export const REWARD_CONTRACT_ADDRESS = '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619';
export const MATT_TOKEN_ADDRESS = '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d';
export const REWARD_TREASURY_ADDRESS = '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc';
export const REWARD_CHAIN_ID = 2020;
export const REWARD_WEIGHTS_BPS = Object.freeze([
  3_000,
  1_800,
  1_200,
  800,
  700,
  600,
  550,
  500,
  450,
  400
]);

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MATT_SCALE = 10n ** BigInt(MATT_TOKEN_DECIMALS);

export function createRewardPlan({
  snapshot,
  poolMatt,
  claimDeadline,
  maxBoardMatt = 100_000
}) {
  assertApi(snapshot?.finalized === true, 409, 'leaderboard_not_finalized', 'The weekly leaderboard must be finalized before rewards are drafted.');
  const mode = normalizeRewardMode(snapshot.mode);
  const week = normalizeRewardWeek(snapshot.week);
  const safeMaximum = Math.min(normalizePositiveInteger(maxBoardMatt, 'maxBoardMatt'), HARD_MAX_BOARD_MATT);
  const requestedMatt = normalizePositiveInteger(poolMatt, 'poolMatt');
  assertApi(
    requestedMatt >= 100,
    422,
    'reward_pool_too_small',
    'Pilot reward drafts require at least 100 MATT so every eligible placement has a positive allocation.'
  );
  assertApi(
    requestedMatt <= safeMaximum,
    422,
    'reward_pool_cap_exceeded',
    `Pilot reward drafts are capped at ${safeMaximum.toLocaleString('en-US')} MATT per board.`
  );
  const deadline = normalizePositiveInteger(claimDeadline, 'claimDeadline');
  const epoch = rewardEpochForWeek(week);
  const board = mode === SERVER_RUN_MODES.FREE ? 0 : 1;
  const requestedRaw = BigInt(requestedMatt) * MATT_SCALE;
  const ranked = [...(snapshot.rows || [])]
    .filter((row) => Number.isSafeInteger(Number(row.rank)) && Number(row.rank) > 0 && Number(row.rank) <= 10)
    .filter((row) => Number(row.score) > 0)
    .sort((left, right) => Number(left.rank) - Number(right.rank));

  assertApi(ranked.length > 0, 409, 'reward_recipients_missing', 'The finalized leaderboard has no eligible top-ten recipients.');
  const eligibleWeight = ranked.reduce(
    (sum, row) => sum + REWARD_WEIGHTS_BPS[Number(row.rank) - 1],
    0
  );
  let allocatedRaw = 0n;
  const entries = ranked.map((row) => {
    const rank = Number(row.rank);
    const address = getAddress(row.address).toLowerCase();
    const amountRaw = (
      requestedRaw *
      BigInt(REWARD_WEIGHTS_BPS[rank - 1])
    ) / BigInt(eligibleWeight);
    allocatedRaw += amountRaw;
    return {
      address,
      rank,
      score: normalizeUnsignedInteger(row.score),
      amountRaw: amountRaw.toString(),
      amountMatt: Number(amountRaw / MATT_SCALE)
    };
  }).filter((entry) => BigInt(entry.amountRaw) > 0n);
  const roundingRemainder = requestedRaw - allocatedRaw;
  if (roundingRemainder > 0n) {
    entries[0].amountRaw = (BigInt(entries[0].amountRaw) + roundingRemainder).toString();
    entries[0].amountMatt = Number(BigInt(entries[0].amountRaw) / MATT_SCALE);
  }

  const values = entries.map((entry) => [
    String(REWARD_CHAIN_ID),
    REWARD_CONTRACT_ADDRESS,
    String(epoch),
    String(board),
    entry.address,
    entry.amountRaw
  ]);
  const tree = createStandardMerkleTree(values);
  const entriesWithProofs = entries.map((entry, index) => ({
    ...entry,
    proof: tree.getProof(index)
  }));
  allocatedRaw = entriesWithProofs
    .reduce((sum, entry) => sum + BigInt(entry.amountRaw), 0n);

  return {
    id: `reward_${week}_${mode}`,
    week,
    mode,
    board,
    epoch: String(epoch),
    requestedMatt,
    requestedRaw: requestedRaw.toString(),
    allocatedMatt: Number(allocatedRaw / MATT_SCALE),
    allocatedRaw: allocatedRaw.toString(),
    unallocatedMatt: Number((requestedRaw - allocatedRaw) / MATT_SCALE),
    merkleRoot: tree.root,
    claimDeadline: deadline,
    participantCount: normalizeUnsignedInteger(snapshot.participantCount),
    snapshotFinalizedAt: snapshot.finalizedAt,
    status: 'draft',
    entries: entriesWithProofs
  };
}

export function rewardEpochForWeek(week) {
  const timestamp = Date.parse(`${normalizeRewardWeek(week)}T00:00:00.000Z`);
  return BigInt(Math.floor(timestamp / WEEK_MS));
}

export function normalizeRewardMode(value) {
  const mode = String(value || '');
  assertApi(
    [SERVER_RUN_MODES.FREE, SERVER_RUN_MODES.PAID].includes(mode),
    400,
    'invalid_reward_board',
    'Choose the Free or Pass reward board.'
  );
  return mode;
}

export function normalizeRewardWeek(value) {
  const week = String(value || '');
  const timestamp = Date.parse(`${week}T00:00:00.000Z`);
  assertApi(
    /^\d{4}-\d{2}-\d{2}$/.test(week) &&
      Number.isFinite(timestamp) &&
      new Date(timestamp).getUTCDay() === 1,
    400,
    'invalid_reward_week',
    'Reward weeks must use the Monday UTC date.'
  );
  return week;
}

function normalizePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new ApiError(422, `invalid_${name}`, `${name} must be a positive whole number.`);
  }
  return parsed;
}

function normalizeUnsignedInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}
