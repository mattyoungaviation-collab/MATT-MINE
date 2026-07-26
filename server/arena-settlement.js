import { encodeFunctionData, getAddress } from 'viem';
import { createSafeTransactionBuilderFile } from './safe-transaction-builder.js';
import { assertApi } from './errors.js';

export const ARENA_WINNER_WEIGHTS_BPS = Object.freeze([
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

export const ARENA_SETTLEMENT_ABI = [{
  type: 'function',
  name: 'settleDay',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'dayId', type: 'uint256' },
    { name: 'winners', type: 'address[]' },
    { name: 'amounts', type: 'uint256[]' }
  ],
  outputs: []
}];

/**
 * Uses integer math in raw token units. When there are fewer than ten winners,
 * only the occupied weights participate and are normalized to 100%. Every floor
 * remainder is deliberately assigned to rank one.
 */
export function allocateArenaPool(poolRaw, rankedEntries) {
  const pool = unsignedBigInt(poolRaw, 'arena_pool_invalid');
  const winners = Array.isArray(rankedEntries) ? rankedEntries.slice(0, 10) : [];
  if (pool === 0n || winners.length === 0) return [];
  const denominator = ARENA_WINNER_WEIGHTS_BPS
    .slice(0, winners.length)
    .reduce((sum, weight) => sum + BigInt(weight), 0n);
  let allocated = 0n;
  const allocations = winners.map((entry, index) => {
    const amount = (pool * BigInt(ARENA_WINNER_WEIGHTS_BPS[index])) / denominator;
    allocated += amount;
    return {
      rank: index + 1,
      address: String(entry.address || '').toLowerCase(),
      score: safeInteger(entry.score),
      weightBps: ARENA_WINNER_WEIGHTS_BPS[index],
      amountRaw: amount.toString()
    };
  });
  allocations[0].amountRaw = (BigInt(allocations[0].amountRaw) + pool - allocated).toString();
  return allocations;
}

export function compareArenaScores(left, right) {
  return (
    safeInteger(right.score) - safeInteger(left.score) ||
    safeInteger(right.depth) - safeInteger(left.depth) ||
    safeInteger(left.guardianTimeMs, Number.MAX_SAFE_INTEGER) -
      safeInteger(right.guardianTimeMs, Number.MAX_SAFE_INTEGER) ||
    safeInteger(left.damageTaken) - safeInteger(right.damageTaken) ||
    safeInteger(left.elapsedMs) - safeInteger(right.elapsedMs) ||
    String(left.entryTransactionHash || '').localeCompare(String(right.entryTransactionHash || ''))
  );
}

export function createArenaSettlementDraft({
  day,
  contractAddress,
  safeAddress,
  poolRaw,
  entries,
  reason = '',
  createdAt = Date.now()
}) {
  const allocations = allocateArenaPool(poolRaw, entries);
  assertApi(allocations.length > 0, 409, 'arena_no_winners', 'The Daily Arena has no eligible winners.');
  const transaction = {
    to: getAddress(contractAddress),
    value: '0',
    data: encodeFunctionData({
      abi: ARENA_SETTLEMENT_ABI,
      functionName: 'settleDay',
      args: [
        BigInt(utcDayId(day)),
        allocations.map((entry) => getAddress(entry.address)),
        allocations.map((entry) => BigInt(entry.amountRaw))
      ]
    })
  };
  const safe = createSafeTransactionBuilderFile([transaction], {
    chainId: 2020,
    createdAt,
    safeAddress: getAddress(safeAddress),
    name: `MATT Mine Daily Arena settlement: ${day}`,
    description: `Prepared settlement for the immutable ${day} UTC Arena snapshot. Review every winner and raw MATT amount before signing.${reason ? ` Reason: ${reason}` : ''}`
  });
  return {
    day,
    poolRaw: BigInt(poolRaw).toString(),
    allocations,
    transaction,
    safe
  };
}

export function utcDayId(day) {
  assertApi(/^\d{4}-\d{2}-\d{2}$/.test(day || ''), 400, 'arena_day_invalid', 'Use a UTC day in YYYY-MM-DD format.');
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  assertApi(Number.isSafeInteger(timestamp), 400, 'arena_day_invalid', 'The UTC day is invalid.');
  return Math.floor(timestamp / 86_400_000);
}

function unsignedBigInt(value, code) {
  try {
    const parsed = BigInt(value);
    assertApi(parsed >= 0n, 400, code, 'A raw MATT amount cannot be negative.');
    return parsed;
  } catch (error) {
    if (error?.code) throw error;
    assertApi(false, 400, code, 'Enter a valid raw MATT integer amount.');
  }
}

function safeInteger(value, fallback = 0) {
  return Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
}
