import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  keccak256,
  parseEventLogs
} from 'viem';
import { ronin } from 'viem/chains';
import { assertApi } from './errors.js';
import { utcDayId } from './arena-settlement.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const BYTES32_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export const RONIN_ARENA_DEPLOYMENT = Object.freeze({
  chainId: 2020,
  contract: '0x506f969279F8264fd629BBB0Df861Ab91343b12C',
  runtimeCodeHash: '0xbe675f45747d267318291cad7295374ad5c65fa06063fe3b8cc111b8fa27453a',
  mattToken: '0xa5450417BDCa0BDfB058ffE41205400FfDA1174d',
  treasurySafe: '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc',
  emergencyPauser: '0x57Dc8DB3a263506a0344eC15B4C623EBb8E589F4',
  temporaryDeployer: '0xeED0491B506C78EA7fD10988B1E98A3C88e1C630',
  deploymentTransaction: '0x5808b7ca0a3006bd469ff63a7d89ff7137bf2108ae24561cd40bf90207dcfe32',
  deploymentBlock: 58_792_525,
  explorerUrl: 'https://explorer.roninchain.com/address/0x506f969279F8264fd629BBB0Df861Ab91343b12C?tab=contract'
});

export const ARENA_ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  },
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
    name: 'seedTreasury',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'address' }]
  },
  {
    type: 'function',
    name: 'DEFAULT_ADMIN_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    type: 'function',
    name: 'TREASURY_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    type: 'function',
    name: 'SETTLER_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    type: 'function',
    name: 'PRICER_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    type: 'function',
    name: 'PAUSER_ROLE',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'bytes32' }]
  },
  {
    type: 'function',
    name: 'hasRole',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' }
    ],
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
    this.expectedContractAddress = options.expectedContractAddress
      ? getAddress(options.expectedContractAddress)
      : null;
    this.runtimeCodeHash = String(options.runtimeCodeHash || '');
    this.safeAddress = options.safeAddress ? getAddress(options.safeAddress) : null;
    this.emergencyPauserAddress = options.emergencyPauserAddress
      ? getAddress(options.emergencyPauserAddress)
      : null;
    this.temporaryDeployerAddress = options.temporaryDeployerAddress
      ? getAddress(options.temporaryDeployerAddress)
      : null;
    this.requireEntriesPaused = options.requireEntriesPaused === true;
    this.confirmations = positiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 120_000);
    this.client = options.client || createPublicClient({
      chain: ronin,
      transport: http(options.rpcUrl || 'https://api.roninchain.com/rpc')
    });
  }

  async validateDeployment() {
    assertApi(
      !this.expectedContractAddress || this.contractAddress === this.expectedContractAddress,
      500,
      'arena_contract_address_mismatch',
      'The configured Daily Arena address is not the approved exact-match deployment.'
    );
    assertApi(
      BYTES32_PATTERN.test(this.runtimeCodeHash),
      500,
      'arena_code_hash_missing',
      'The approved Daily Arena runtime code hash is not configured.'
    );
    assertApi(
      this.safeAddress && this.emergencyPauserAddress && this.temporaryDeployerAddress,
      500,
      'arena_role_config_missing',
      'The approved Arena Safe, emergency pauser, and temporary deployer are not configured.'
    );

    const code = await this.client.getCode({ address: this.contractAddress });
    assertApi(
      typeof code === 'string' && code !== '0x',
      503,
      'arena_contract_code_missing',
      'No deployed code exists at the configured Daily Arena address.'
    );
    const runtimeCodeHash = keccak256(code);
    assertApi(
      runtimeCodeHash.toLowerCase() === this.runtimeCodeHash.toLowerCase(),
      503,
      'arena_contract_code_mismatch',
      'The configured Daily Arena bytecode does not match the exact verified deployment.'
    );

    const [
      mattToken,
      seedTreasury,
      entriesPaused,
      settlementPaused,
      defaultAdminRole,
      treasuryRole,
      settlerRole,
      pricerRole,
      pauserRole
    ] = await Promise.all([
      this.#read('matt'),
      this.#read('seedTreasury'),
      this.#read('entriesPaused'),
      this.#read('settlementPaused'),
      this.#read('DEFAULT_ADMIN_ROLE'),
      this.#read('TREASURY_ROLE'),
      this.#read('SETTLER_ROLE'),
      this.#read('PRICER_ROLE'),
      this.#read('PAUSER_ROLE')
    ]);

    assertApi(
      sameAddress(mattToken, this.mattTokenAddress),
      503,
      'arena_matt_token_mismatch',
      'The configured MATT token does not match the immutable Daily Arena token.'
    );
    assertApi(
      sameAddress(seedTreasury, this.safeAddress),
      503,
      'arena_seed_treasury_mismatch',
      'The Daily Arena seed Treasury is not the approved Safe.'
    );

    const expectedRoleChecks = await Promise.all([
      this.#hasRole(defaultAdminRole, this.safeAddress),
      this.#hasRole(treasuryRole, this.safeAddress),
      this.#hasRole(settlerRole, this.safeAddress),
      this.#hasRole(pricerRole, this.safeAddress),
      this.#hasRole(pauserRole, this.emergencyPauserAddress)
    ]);
    assertApi(
      expectedRoleChecks.every(Boolean),
      503,
      'arena_role_mismatch',
      'One or more Daily Arena production roles are not assigned to the approved controller.'
    );
    const removedDeployerRoles = await Promise.all([
      defaultAdminRole,
      treasuryRole,
      settlerRole,
      pricerRole,
      pauserRole
    ].map((role) => this.#hasRole(role, this.temporaryDeployerAddress)));
    assertApi(
      removedDeployerRoles.every((assigned) => assigned === false),
      503,
      'arena_deployer_role_present',
      'The temporary Arena deployer still holds a production role.'
    );
    assertApi(
      !this.requireEntriesPaused || entriesPaused === true,
      503,
      'arena_entries_not_paused',
      'Daily Arena entries must remain paused while production live mode is disabled.'
    );

    return {
      pinned: true,
      contract: this.contractAddress,
      runtimeCodeHash,
      mattToken: getAddress(mattToken),
      treasurySafe: this.safeAddress,
      emergencyPauser: this.emergencyPauserAddress,
      temporaryDeployer: this.temporaryDeployerAddress,
      entriesPaused: Boolean(entriesPaused),
      settlementPaused: Boolean(settlementPaused)
    };
  }

  #read(functionName) {
    return this.client.readContract({
      address: this.contractAddress,
      abi: DAILY_ARENA_ABI,
      functionName
    });
  }

  #hasRole(role, account) {
    return this.client.readContract({
      address: this.contractAddress,
      abi: DAILY_ARENA_ABI,
      functionName: 'hasRole',
      args: [role, account]
    });
  }

  publicConfig() {
    return {
      chainId: 2020,
      contract: this.contractAddress,
      mattToken: this.mattTokenAddress,
      confirmations: this.confirmations,
      explorerUrl: 'https://explorer.roninchain.com',
      exactMatchDeployment: this.expectedContractAddress === this.contractAddress
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
    const [balance, allowance, ronBalance] = await Promise.all([
      this.client.readContract({
        address: this.mattTokenAddress,
        abi: ARENA_ERC20_ABI,
        functionName: 'balanceOf',
        args: [player]
      }),
      this.client.readContract({
        address: this.mattTokenAddress,
        abi: ARENA_ERC20_ABI,
        functionName: 'allowance',
        args: [player, this.contractAddress]
      }),
      typeof this.client.getBalance === 'function'
        ? this.client.getBalance({ address: player })
        : null
    ]);
    const mattBalance = BigInt(balance);
    assertApi(
      mattBalance >= fee,
      409,
      'arena_matt_balance_insufficient',
      `Arena entry costs ${formatMattAtomic(fee)} MATT, but this wallet currently has ${formatMattAtomic(mattBalance)} MATT on Ronin Mainnet.`,
      {
        requiredRaw: fee.toString(),
        balanceRaw: mattBalance.toString(),
        shortfallRaw: (fee - mattBalance).toString()
      }
    );
    const transactions = [];
    if (BigInt(allowance) < fee) {
      transactions.push({
        kind: 'approve',
        chainId: 2020,
        to: this.mattTokenAddress,
        value: '0x0',
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
      value: '0x0',
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
      balanceRaw: mattBalance.toString(),
      ronBalanceRaw: ronBalance === null ? null : BigInt(ronBalance).toString(),
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
        value: '0x0',
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

function formatMattAtomic(value) {
  const raw = BigInt(value);
  const scale = 10n ** 18n;
  const whole = raw / scale;
  const fraction = (raw % scale)
    .toString()
    .padStart(18, '0')
    .slice(0, 4)
    .replace(/0+$/, '');
  return `${whole.toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
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
