import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseEventLogs
} from 'viem';
import { ApiError, assertApi } from './errors.js';
import { createRoninReadClient } from './ronin-rpc.js';

export const RONIN_PAYMENT_CONTRACTS = Object.freeze({
  pass: '0x56a6d4Cf4Fbd1C7aA1572028556657CbC0fB5855',
  runs: '0x4B5D10f6DA960436c5E3c23F40C52d36E2225555',
  matt: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d',
  wrappedRon: '0xe514d9DEB7966c8BE0ca922de8a064264eA6bcd4',
  router: '0x7D0556D55ca1a92708681e2e231733EBd922597D'
});

export const MATT_MINE_PASS_ABI = [
  {
    type: 'function',
    name: 'hasActivePass',
    stateMutability: 'view',
    inputs: [{ name: 'player', type: 'address' }],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'passExpiresAt',
    stateMutability: 'view',
    inputs: [{ name: 'player', type: 'address' }],
    outputs: [{ type: 'uint64' }]
  },
  {
    type: 'function',
    name: 'passPriceRon',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'purchasePass',
    stateMutability: 'payable',
    inputs: [],
    outputs: []
  },
  {
    type: 'event',
    name: 'PassPurchased',
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'priceRon', type: 'uint256', indexed: false },
      { name: 'expiresAt', type: 'uint64', indexed: false }
    ]
  }
];

export const MATT_MINE_RUNS_ABI = [
  {
    type: 'function',
    name: 'paidRunPriceRon',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'paidRunsToday',
    stateMutability: 'view',
    inputs: [{ name: 'player', type: 'address' }],
    outputs: [{ type: 'uint8' }]
  },
  {
    type: 'function',
    name: 'paused',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'purchasePaidRun',
    stateMutability: 'payable',
    inputs: [
      { name: 'minMattOut', type: 'uint256' },
      { name: 'deadline', type: 'uint256' }
    ],
    outputs: [{ name: 'entitlementId', type: 'uint256' }]
  },
  {
    type: 'event',
    name: 'PaidRunPurchased',
    inputs: [
      { name: 'player', type: 'address', indexed: true },
      { name: 'entitlementId', type: 'uint256', indexed: true },
      { name: 'ronPaid', type: 'uint256', indexed: false },
      { name: 'mattBought', type: 'uint256', indexed: false },
      { name: 'currentPoolMatt', type: 'uint256', indexed: false },
      { name: 'futureRewardsMatt', type: 'uint256', indexed: false },
      { name: 'reserveMatt', type: 'uint256', indexed: false }
    ]
  }
];

const ROUTER_ABI = [
  {
    type: 'function',
    name: 'getAmountsOut',
    stateMutability: 'view',
    inputs: [
      { name: 'amountIn', type: 'uint256' },
      { name: 'path', type: 'address[]' }
    ],
    outputs: [{ name: 'amounts', type: 'uint256[]' }]
  }
];

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const LAUNCH_PASS_PRICE_WEI = 95n * 10n ** 18n;
const LAUNCH_PAID_RUN_PRICE_WEI = 10n * 10n ** 18n;

export const MATT_MINE_LAUNCH_PRICES = Object.freeze({
  passPriceRonWei: String(LAUNCH_PASS_PRICE_WEI),
  paidRunPriceRonWei: String(LAUNCH_PAID_RUN_PRICE_WEI)
});

export class RoninPaymentVerifier {
  constructor(options = {}) {
    this.contracts = {
      ...RONIN_PAYMENT_CONTRACTS,
      ...(options.contracts || {})
    };
    this.confirmations = safePositiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = safePositiveInteger(options.receiptTimeoutMs, 120_000);
    this.slippageBps = safeBps(options.slippageBps, 500);
    this.quoteLifetimeSeconds = safePositiveInteger(options.quoteLifetimeSeconds, 300);
    const rpc = options.client ? null : createRoninReadClient({
      urls: options.rpcUrls || options.rpcUrl,
      timeoutMs: options.rpcTimeoutMs
    });
    this.client = options.client || rpc.client;
    this.rpcPool = options.rpcPool || rpc?.pool || null;
  }

  publicConfig() {
    return {
      contracts: {
        pass: this.contracts.pass,
        runs: this.contracts.runs,
        matt: this.contracts.matt
      },
      confirmations: this.confirmations,
      explorerUrl: 'https://explorer.roninchain.com'
    };
  }

  async publicStatus() {
    const [passPriceRon, passPaused, paidRunPriceRon, runsPaused] = await Promise.all([
      this.read(this.contracts.pass, MATT_MINE_PASS_ABI, 'passPriceRon'),
      this.read(this.contracts.pass, MATT_MINE_PASS_ABI, 'paused'),
      this.read(this.contracts.runs, MATT_MINE_RUNS_ABI, 'paidRunPriceRon'),
      this.read(this.contracts.runs, MATT_MINE_RUNS_ABI, 'paused')
    ]);
    return {
      live: true,
      pass: {
        priceRonWei: String(passPriceRon),
        paused: passPaused === true
      },
      paidRuns: {
        priceRonWei: String(paidRunPriceRon),
        paused: runsPaused === true
      }
    };
  }

  async status(address) {
    const player = getAddress(address);
    const [passActive, passExpiresAt, passPriceRon, passPaused, paidRunPriceRon, paidRunsToday, runsPaused] =
      await Promise.all([
        this.read(this.contracts.pass, MATT_MINE_PASS_ABI, 'hasActivePass', [player]),
        this.read(this.contracts.pass, MATT_MINE_PASS_ABI, 'passExpiresAt', [player]),
        this.read(this.contracts.pass, MATT_MINE_PASS_ABI, 'passPriceRon'),
        this.read(this.contracts.pass, MATT_MINE_PASS_ABI, 'paused'),
        this.read(this.contracts.runs, MATT_MINE_RUNS_ABI, 'paidRunPriceRon'),
        this.read(this.contracts.runs, MATT_MINE_RUNS_ABI, 'paidRunsToday', [player]),
        this.read(this.contracts.runs, MATT_MINE_RUNS_ABI, 'paused')
      ]);

    return {
      pass: {
        active: passActive === true,
        expiresAt: Number(passExpiresAt) * 1000,
        priceRonWei: String(passPriceRon),
        paused: passPaused === true,
        transaction: {
          to: this.contracts.pass,
          value: toQuantityHex(passPriceRon),
          data: encodeFunctionData({ abi: MATT_MINE_PASS_ABI, functionName: 'purchasePass' })
        }
      },
      paidRuns: {
        priceRonWei: String(paidRunPriceRon),
        purchasedToday: Number(paidRunsToday),
        dailyLimit: 10,
        paused: runsPaused === true
      }
    };
  }

  async quotePaidRun(address) {
    const status = await this.status(address);
    assertApi(status.pass.active, 403, 'active_pass_required', 'An active MATT Mine Pass is required.');
    assertApi(!status.paidRuns.paused, 503, 'paid_runs_paused', 'Paid-run purchases are currently paused.');
    assertApi(
      status.paidRuns.purchasedToday < status.paidRuns.dailyLimit,
      409,
      'paid_run_daily_limit',
      'This wallet has reached the daily paid-run purchase limit.'
    );

    const price = BigInt(status.paidRuns.priceRonWei);
    const amounts = await this.read(this.contracts.router, ROUTER_ABI, 'getAmountsOut', [
      price,
      [this.contracts.wrappedRon, this.contracts.matt]
    ]);
    assertApi(Array.isArray(amounts) && amounts.length === 2 && amounts[1] > 0n, 503, 'swap_quote_unavailable', 'Katana did not return a valid MATT quote.');
    const quotedMattOut = amounts[1];
    const minMattOut = (quotedMattOut * BigInt(10_000 - this.slippageBps)) / 10_000n;
    assertApi(minMattOut > 0n, 503, 'swap_quote_too_small', 'The protected MATT output is too small.');
    const latestBlock = await this.client.getBlock({ blockTag: 'latest' });
    const deadline = latestBlock.timestamp + BigInt(this.quoteLifetimeSeconds);

    return {
      quotedMattOut: String(quotedMattOut),
      minMattOut: String(minMattOut),
      slippageBps: this.slippageBps,
      deadline: Number(deadline),
      transaction: {
        to: this.contracts.runs,
        value: toQuantityHex(price),
        data: encodeFunctionData({
          abi: MATT_MINE_RUNS_ABI,
          functionName: 'purchasePaidRun',
          args: [minMattOut, deadline]
        })
      }
    };
  }

  async verifyPaidRunPurchase(transactionHash, expectedAddress) {
    assertApi(
      typeof transactionHash === 'string' && TRANSACTION_HASH_PATTERN.test(transactionHash),
      400,
      'invalid_transaction_hash',
      'A valid Ronin transaction hash is required.'
    );
    const hash = transactionHash.toLowerCase();
    const expectedPlayer = getAddress(expectedAddress);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.receiptTimeoutMs
      });
    } catch {
      throw new ApiError(409, 'transaction_confirming', 'The paid-run transaction is not confirmed yet. Try again shortly.');
    }
    assertApi(receipt.status === 'success', 422, 'transaction_reverted', 'The paid-run transaction reverted.');
    assertApi(
      receipt.to && sameAddress(receipt.to, this.contracts.runs),
      422,
      'wrong_payment_contract',
      'The transaction was not sent to the approved MATT Mine Runs contract.'
    );

    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, expectedPlayer), 403, 'payment_wallet_mismatch', 'The paid run was purchased by another wallet.');
    assertApi(sameAddress(transaction.to, this.contracts.runs), 422, 'wrong_payment_contract', 'The transaction target is not approved.');
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: MATT_MINE_RUNS_ABI, data: transaction.input });
    } catch {
      throw new ApiError(422, 'invalid_payment_call', 'The transaction did not call purchasePaidRun.');
    }
    assertApi(decoded.functionName === 'purchasePaidRun', 422, 'invalid_payment_call', 'The transaction did not call purchasePaidRun.');

    const events = parseEventLogs({
      abi: MATT_MINE_RUNS_ABI,
      logs: receipt.logs.filter((log) => sameAddress(log.address, this.contracts.runs)),
      eventName: 'PaidRunPurchased',
      strict: true
    });
    const event = events.find((entry) => sameAddress(entry.args.player, expectedPlayer));
    assertApi(event, 422, 'paid_run_event_missing', 'The confirmed transaction did not issue a paid-run entitlement to this wallet.');
    assertApi(event.args.ronPaid === transaction.value, 422, 'payment_event_mismatch', 'The paid-run event does not match the RON payment.');

    return {
      key: `${hash}:${event.logIndex}`,
      transactionHash: hash,
      logIndex: event.logIndex,
      blockNumber: String(receipt.blockNumber),
      address: expectedPlayer.toLowerCase(),
      entitlementId: String(event.args.entitlementId),
      ronPaid: String(event.args.ronPaid),
      mattBought: String(event.args.mattBought),
      currentPoolMatt: String(event.args.currentPoolMatt),
      futureRewardsMatt: String(event.args.futureRewardsMatt),
      reserveMatt: String(event.args.reserveMatt)
    };
  }

  async verifyPassPurchase(transactionHash, expectedAddress) {
    assertApi(
      typeof transactionHash === 'string' && TRANSACTION_HASH_PATTERN.test(transactionHash),
      400,
      'invalid_transaction_hash',
      'A valid Ronin transaction hash is required.'
    );
    const hash = transactionHash.toLowerCase();
    const expectedPlayer = getAddress(expectedAddress);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.receiptTimeoutMs
      });
    } catch {
      throw new ApiError(409, 'transaction_confirming', 'The Pass transaction is not confirmed yet. Try again shortly.');
    }
    assertApi(receipt.status === 'success', 422, 'transaction_reverted', 'The Pass transaction reverted.');
    assertApi(
      receipt.to && sameAddress(receipt.to, this.contracts.pass),
      422,
      'wrong_payment_contract',
      'The transaction was not sent to the approved MATT Mine Pass contract.'
    );

    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, expectedPlayer), 403, 'payment_wallet_mismatch', 'The Pass was purchased by another wallet.');
    assertApi(sameAddress(transaction.to, this.contracts.pass), 422, 'wrong_payment_contract', 'The transaction target is not approved.');
    let decoded;
    try {
      decoded = decodeFunctionData({ abi: MATT_MINE_PASS_ABI, data: transaction.input });
    } catch {
      throw new ApiError(422, 'invalid_payment_call', 'The transaction did not call purchasePass.');
    }
    assertApi(decoded.functionName === 'purchasePass', 422, 'invalid_payment_call', 'The transaction did not call purchasePass.');

    const events = parseEventLogs({
      abi: MATT_MINE_PASS_ABI,
      logs: receipt.logs.filter((log) => sameAddress(log.address, this.contracts.pass)),
      eventName: 'PassPurchased',
      strict: true
    });
    const event = events.find((entry) => sameAddress(entry.args.player, expectedPlayer));
    assertApi(event, 422, 'pass_event_missing', 'The confirmed transaction did not activate a Pass for this wallet.');
    assertApi(event.args.priceRon === transaction.value, 422, 'payment_event_mismatch', 'The Pass event does not match the RON payment.');

    return {
      key: `${hash}:${event.logIndex}`,
      transactionHash: hash,
      logIndex: event.logIndex,
      blockNumber: String(receipt.blockNumber),
      address: expectedPlayer.toLowerCase(),
      priceRon: String(event.args.priceRon),
      expiresAt: Number(event.args.expiresAt) * 1000
    };
  }

  read(address, abi, functionName, args = []) {
    return this.client.readContract({ address, abi, functionName, args });
  }
}

function toQuantityHex(value) {
  return `0x${BigInt(value).toString(16)}`;
}

function sameAddress(left, right) {
  try {
    return getAddress(left) === getAddress(right);
  } catch {
    return false;
  }
}

function safePositiveInteger(value, fallback) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
}

function safeBps(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= 2_000 ? number : fallback;
}
