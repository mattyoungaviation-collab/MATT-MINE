import { getAddress, keccak256, toBytes } from 'viem';

export const SAFE_TRANSACTION_BUILDER_VERSION = '1.18.0';

export function createSafeTransactionBuilderFile(transactions, options = {}) {
  const entries = Array.isArray(transactions) ? transactions : [transactions];
  if (entries.length === 0) throw new TypeError('At least one Safe transaction is required.');

  const batch = {
    version: '1.0',
    chainId: String(options.chainId || 2020),
    createdAt: normalizeTimestamp(options.createdAt),
    meta: {
      name: String(options.name || 'MATT Mine transactions'),
      description: String(options.description || ''),
      txBuilderVersion: SAFE_TRANSACTION_BUILDER_VERSION,
      createdFromSafeAddress: getAddress(options.safeAddress),
      createdFromOwnerAddress: ''
    },
    transactions: entries.map(normalizeTransaction)
  };
  batch.meta.checksum = calculateSafeTransactionBuilderChecksum(batch);
  return batch;
}

export function calculateSafeTransactionBuilderChecksum(batch) {
  const checksumInput = structuredClone(batch);
  checksumInput.meta = { ...checksumInput.meta, name: null };
  delete checksumInput.meta.checksum;
  return keccak256(toBytes(serializeSafeJson(checksumInput)));
}

function normalizeTransaction(transaction = {}) {
  const value = transaction.value === undefined || transaction.value === null
    ? '0'
    : BigInt(transaction.value).toString();
  const data = transaction.data && transaction.data !== '0x'
    ? String(transaction.data)
    : null;
  if (data !== null && !/^0x(?:[a-fA-F0-9]{2})*$/.test(data)) {
    throw new TypeError('Safe transaction calldata must be hexadecimal bytes.');
  }
  return {
    to: getAddress(transaction.to),
    value,
    data,
    contractMethod: null,
    contractInputsValues: null
  };
}

function normalizeTimestamp(value) {
  const timestamp = value === undefined ? Date.now() : Number(value);
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new TypeError('Safe transaction creation time must be a non-negative millisecond timestamp.');
  }
  return timestamp;
}

function serializeSafeJson(value) {
  if (Array.isArray(value)) return `[${value.map(serializeSafeJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    let output = `{${JSON.stringify(keys)}`;
    for (const key of keys) output += `${serializeSafeJson(value[key])},`;
    return `${output}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}
