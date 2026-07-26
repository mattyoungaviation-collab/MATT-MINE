import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  parseEventLogs
} from 'viem';
import { ronin } from 'viem/chains';
import { assertApi } from './errors.js';
import { utcDayId } from './arena-settlement.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export const ARENA_ERC20_ABI = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  }
];

export const DAILY_ARENA_ABI = [
  {
    type: 'function',
    name: 'matt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'entriesPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'settlementPaused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'getDay',
    stateMutability: 'view',
    inputs: [{ name: 'dayId', type: 'uint256' }],
    outputs: [{
      name: 'day',
      type: 'tuple',
      components: [
        { name: 'status', type: 'uint8' },
        { name: 'entryFeeMatt', type: 'uint256' },
        { name: 'entryCount', type: 'uint256' },
        { name: 'entryMatt', type: 'uint256' },
        { name: 'seededMatt', type: 'uint256' },
        { name: 'reservedMatt', type: 'uint256' },
        { name: 'settledMatt', type: 'uint256' },
        { name: 'refundedMatt', type: 'uint256' }
      ]
    }]
  },
  {
    type: 'function',
    name: 'enter',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'dayId', type: 'uint256' }],
    outputs: [{ name: 'entryNumber', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'scheduleDay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dayId', type: 'uint256' },
      { name: 'entryFeeMatt', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'seedDay',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'dayId', type: 'uint256' },
      { name: 'mattAmount', type: 'uint256' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'cancelDay',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'dayId', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'refundableMatt',
    stateMutability: 'view',
    inputs: [
      { name: 'dayId', type: 'uint256' },
      { name: 'wallet', type: 'address' }
    ],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'claimEntryRefund',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'dayId', type: 'uint256' }],
    outputs: [{ name: 'mattAmount', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'pauseEntries',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'unpauseEntries',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'pauseSettlement',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'function',
    name: 'unpauseSettlement',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: []
  },
  {
    type: 'event',
    name: 'ContestEntered',
    inputs: [
      { name: 'dayId', type: 'uint256', indexed: true },
      { name: 'entryNumber', type: 'uint256', indexed: true },
      { name: 'wallet', type: 'address', indexed: true },
      { name: 'mattPaid', type: 'uint256', indexed: false },
      { name: 'totalPoolMatt', type: 'uint256', indexed: false }
    ]
  }
];

export class RoninArenaChain {
  constructor(options = {}) {
    assertApi(options.contractAddress, 500, 'arena_contract_missing', 'The Daily Arena contract address is not configured.');
    this.contractAddress = getAddress(options.contractAddress);
    this.mattTokenAddress = getAddress(options.mattTokenAddress);
    this.confirmations = positiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 120_000);
    this.client = options.client || createPublicClient({
      chain: ronin,
      transport: http(options.rpcUrl || 'https://api.roninchain.com/rpc')
    });
  }

  publicConfig() {
    return {
      chainId: 2020,
      contract: this.contractAddress,
      mattToken: this.mattTokenAddress,
      confirmations: this.confirmations,
      explorerUrl: 'https://explorer.roninchain.com'
    };
  }

  async dayStatus(day) {
    const dayId = BigInt(utcDayId(day));
    const [raw, entriesPaused, settlementPaused, mattToken] = await Promise.all([
      this.client.readContract({
        address: this.contractAddress,
        abi: DAILY_ARENA_ABI,
        functionName: 'getDay',
        args: [dayId]
      }),
      this.client.readContract({
        address: this.contractAddress,
        abi: DAILY_ARENA_ABI,
        functionName: 'entriesPaused'
      }),
      this.client.readContract({
        address: this.contractAddress,
        abi: DAILY_ARENA_ABI,
        functionName: 'settlementPaused'
      }),
      this.client.readContract({
        address: this.contractAddress,
        abi: DAILY_ARENA_ABI,
        functionName: 'matt'
      })
    ]);
    assertApi(
      sameAddress(mattToken, this.mattTokenAddress),
      503,
      'arena_matt_token_mismatch',
      'The configured MATT token does not match the immutable Daily Arena token.'
    );
    const value = normalizeDayTuple(raw);
    return {
      day,
      dayId: Number(dayId),
      status: value.status,
      scheduled: value.status === 1,
      entriesPaused: Boolean(entriesPaused),
      settlementPaused: Boolean(settlementPaused),
      entryFeeRaw: value.entryFeeMatt.toString(),
      entryCount: value.entryCount.toString(),
      entryPoolRaw: value.entryMatt.toString(),
      seededRaw: value.seededMatt.toString(),
      reservedRaw: value.reservedMatt.toString(),
      settledRaw: value.settledMatt.toString(),
      refundedRaw: value.refundedMatt.toString()
    };
  }

  async quoteEntry(address, day, expectedFeeRaw) {
    const player = getAddress(address);
    const status = await this.dayStatus(day);
    assertApi(status.scheduled, 409, 'arena_day_not_scheduled', 'This UTC day is not scheduled on the Daily Arena contract.');
    assertApi(!status.entriesPaused, 503, 'arena_entries_paused', 'Daily Arena entries are paused onchain.');
    assertApi(status.entryFeeRaw === String(expectedFeeRaw), 409, 'arena_fee_snapshot_mismatch', 'The onchain Arena fee does not match the immutable server snapshot.');
    const fee = BigInt(status.entryFeeRaw);
    const allowance = await this.client.readContract({
      address: this.mattTokenAddress,
      abi: ARENA_ERC20_ABI,
      functionName: 'allowance',
      args: [player, this.contractAddress]
    });
    const transactions = [];
    if (BigInt(allowance) < fee) {
      transactions.push({
        kind: 'approve',
        chainId: 2020,
        to: this.mattTokenAddress,
        value: '0',
        data: encodeFunctionData({
          abi: ARENA_ERC20_ABI,
          functionName: 'approve',
          args: [this.contractAddress, fee]
        }),
        amountRaw: fee.toString(),
        spender: this.contractAddress
      });
    }
    transactions.push({
      kind: 'enter',
      chainId: 2020,
      to: this.contractAddress,
      value: '0',
      data: encodeFunctionData({
        abi: DAILY_ARENA_ABI,
        functionName: 'enter',
        args: [BigInt(status.dayId)]
      }),
      day,
      dayId: status.dayId,
      amountRaw: fee.toString()
    });
    return {
      day,
      dayId: status.dayId,
      amountRaw: fee.toString(),
      allowanceRaw: BigInt(allowance).toString(),
      transactions
    };
  }

  async quoteRefund(address, day) {
    const player = getAddress(address);
    const dayId = BigInt(utcDayId(day));
    const refundable = BigInt(await this.client.readContract({
      address: this.contractAddress,
      abi: DAILY_ARENA_ABI,
      functionName: 'refundableMatt',
      args: [dayId, player]
    }));
    assertApi(refundable > 0n, 409, 'arena_refund_unavailable', 'This wallet has no refundable MATT for the selected Arena day.');
    return {
      day,
      dayId: Number(dayId),
      refundRaw: refundable.toString(),
      transaction: {
        kind: 'claim_refund',
        chainId: 2020,
        to: this.contractAddress,
        value: '0',
        data: encodeFunctionData({
          abi: DAILY_ARENA_ABI,
          functionName: 'claimEntryRefund',
          args: [dayId]
        })
      }
    };
  }

  async refundable(address, day) {
    const value = await this.client.readContract({
      address: this.contractAddress,
      abi: DAILY_ARENA_ABI,
      functionName: 'refundableMatt',
      args: [BigInt(utcDayId(day)), getAddress(address)]
    });
    return BigInt(value).toString();
  }

  async verifyEntryPurchase(transactionHash, expectedAddress, expectedDay = '', expectedFeeRaw = undefined) {
    assertApi(
      typeof transactionHash === 'string' && TRANSACTION_HASH_PATTERN.test(transactionHash),
      400,
      'arena_transaction_hash_invalid',
      'A valid Daily Arena entry transaction hash is required.'
    );
    const hash = transactionHash.toLowerCase();
    const player = getAddress(expectedAddress);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.receiptTimeoutMs
      });
    } catch {
      assertApi(false, 409, 'arena_transaction_confirming', 'The Daily Arena entry transaction is not confirmed yet.');
    }
    assertApi(receipt.status === 'success', 422, 'arena_transaction_reverted', 'The Daily Arena entry transaction reverted.');
    assertApi(
      sameAddress(receipt.to, this.contractAddress),
      422,
      'arena_contract_mismatch',
      'The entry transaction was not sent to the configured Daily Arena contract.'
    );
    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, player), 403, 'arena_payment_wallet_mismatch', 'The Daily Arena entry was purchased by another wallet.');
    assertApi(sameAddress(transaction.to, this.contractAddress), 422, 'arena_contract_mismatch', 'The entry transaction target is not approved.');
    assertApi(BigInt(transaction.value || 0n) === 0n, 422, 'arena_transaction_value_invalid', 'Daily Arena entry transactions cannot send native RON.');
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: DAILY_ARENA_ABI, data: transaction.input });
    } catch {
      assertApi(false, 422, 'arena_entry_call_invalid', 'The transaction did not call Daily Arena enter.');
    }
    assertApi(decoded.functionName === 'enter', 422, 'arena_entry_call_invalid', 'The transaction did not call Daily Arena enter.');
    const enteredDayId = BigInt(decoded.args[0]);
    assertApi(enteredDayId >= 0n && enteredDayId <= BigInt(Number.MAX_SAFE_INTEGER), 422, 'arena_entry_day_mismatch', 'The transaction contains an unsupported UTC Arena day.');
    if (expectedDay) {
      assertApi(enteredDayId === BigInt(utcDayId(expectedDay)), 422, 'arena_entry_day_mismatch', 'The transaction entered a different UTC Arena day.');
    }
    const enteredDay = dayKeyFromId(enteredDayId);
    const events = parseEventLogs({
      abi: DAILY_ARENA_ABI,
      logs: receipt.logs.filter((log) => sameAddress(log.address, this.contractAddress)),
      eventName: 'ContestEntered',
      strict: true
    });
    const event = events.find((candidate) =>
      sameAddress(candidate.args.wallet, player) &&
      BigInt(candidate.args.dayId) === enteredDayId
    );
    assertApi(event, 422, 'arena_entry_event_missing', 'The confirmed transaction did not emit the expected Arena entry.');
    if (expectedFeeRaw !== undefined) {
      assertApi(
        BigInt(event.args.mattPaid).toString() === String(expectedFeeRaw),
        422,
        'arena_fee_mismatch',
        'The confirmed Arena entry did not pay the immutable daily fee.'
      );
    }
    const block = await this.client.getBlock?.({ blockNumber: receipt.blockNumber }).catch(() => null);
    return {
      paymentKey: `${hash}:${event.logIndex}`,
      transactionHash: hash,
      logIndex: Number(event.logIndex),
      blockNumber: String(receipt.blockNumber),
      address: player.toLowerCase(),
      day: enteredDay,
      dayId: Number(enteredDayId),
      entryNumber: String(event.args.entryNumber),
      amountRaw: String(event.args.mattPaid),
      totalPoolRaw: String(event.args.totalPoolMatt),
      blockTimestampMs: block ? Number(block.timestamp) * 1_000 : 0
    };
  }
}

function normalizeDayTuple(value) {
  if (Array.isArray(value)) {
    return {
      status: Number(value[0]),
      entryFeeMatt: BigInt(value[1]),
      entryCount: BigInt(value[2]),
      entryMatt: BigInt(value[3]),
      seededMatt: BigInt(value[4]),
      reservedMatt: BigInt(value[5]),
      settledMatt: BigInt(value[6]),
      refundedMatt: BigInt(value[7])
    };
  }
  return {
    status: Number(value.status),
    entryFeeMatt: BigInt(value.entryFeeMatt),
    entryCount: BigInt(value.entryCount),
    entryMatt: BigInt(value.entryMatt),
    seededMatt: BigInt(value.seededMatt),
    reservedMatt: BigInt(value.reservedMatt),
    settledMatt: BigInt(value.settledMatt),
    refundedMatt: BigInt(value.refundedMatt)
  };
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function positiveInteger(value, fallback) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function dayKeyFromId(dayId) {
  const timestamp = Number(dayId) * 86_400_000;
  assertApi(Number.isSafeInteger(timestamp), 422, 'arena_entry_day_mismatch', 'The transaction contains an unsupported UTC Arena day.');
  return new Date(timestamp).toISOString().slice(0, 10);
}
