import { encodeFunctionData, getAddress, parseEther, parseUnits } from 'viem';
import { ApiError, assertApi } from './errors.js';
import { RONIN_PAYMENT_CONTRACTS } from './payment-verifier.js';
import { createSafeTransactionBuilderFile } from './safe-transaction-builder.js';

export const MATT_MINE_ADMIN_CONTRACTS = Object.freeze({
  ...RONIN_PAYMENT_CONTRACTS,
  rewards: '0x6ba468EE15cb3634F4Ea340407E9FD7A75267619',
  swapExecutor: '0x9f700037e9C8B3FfB5eDA15CDcf5a76bce235Af0',
  safe: '0xBacE355D23d378a6E1adD986E53a18Dd12E6EeAc'
});

const PAUSE_ABI = [
  { type: 'function', name: 'pause', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'unpause', stateMutability: 'nonpayable', inputs: [], outputs: [] }
];

const PASS_ABI = [
  ...PAUSE_ABI,
  {
    type: 'function',
    name: 'setPassPriceRon',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newPriceRon', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'setRevenueRecipients',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'newOperationsTreasury', type: 'address' },
      { name: 'newRewardsTreasury', type: 'address' },
      { name: 'newGrowthTreasury', type: 'address' }
    ],
    outputs: []
  }
];

const RUNS_ABI = [
  ...PAUSE_ABI,
  {
    type: 'function',
    name: 'setPaidRunPriceRon',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newPriceRon', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'setSwapExecutor',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newExecutor', type: 'address' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'setRewardDestinations',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'newCurrentRewardsVault', type: 'address' },
      { name: 'newFutureRewardsTreasury', type: 'address' },
      { name: 'newReserveTreasury', type: 'address' }
    ],
    outputs: []
  }
];

const REWARDS_ABI = [
  ...PAUSE_ABI,
  {
    type: 'function',
    name: 'fundRewards',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'mattAmount', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'recoverExpiredRewards',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'board', type: 'uint8' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'recoverUnallocatedRewards',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'mattAmount', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'setReserveTreasury',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newReserveTreasury', type: 'address' }],
    outputs: []
  }
];

const MATT_ABI = [{
  type: 'function',
  name: 'approve',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'spender', type: 'address' },
    { name: 'amount', type: 'uint256' }
  ],
  outputs: [{ type: 'bool' }]
}];

const ACTIONS = Object.freeze({
  pass_pause: action('pass', PASS_ABI, 'pause', 'Emergency pauser', []),
  pass_unpause: action('pass', PASS_ABI, 'unpause', 'Emergency pauser', []),
  runs_pause: action('runs', RUNS_ABI, 'pause', 'Emergency pauser', []),
  runs_unpause: action('runs', RUNS_ABI, 'unpause', 'Emergency pauser', []),
  rewards_pause: action('rewards', REWARDS_ABI, 'pause', 'Emergency pauser', []),
  rewards_unpause: action('rewards', REWARDS_ABI, 'unpause', 'Emergency pauser', []),
  swap_pause: action('swapExecutor', PAUSE_ABI, 'pause', 'Emergency pauser', []),
  swap_unpause: action('swapExecutor', PAUSE_ABI, 'unpause', 'Emergency pauser', []),
  pass_price: action('pass', PASS_ABI, 'setPassPriceRon', 'Price manager', ['ron']),
  run_price: action('runs', RUNS_ABI, 'setPaidRunPriceRon', 'Price manager', ['ron']),
  pass_recipients: action('pass', PASS_ABI, 'setRevenueRecipients', 'MATT Mine Treasury Safe (contract must be paused)', ['address', 'address', 'address']),
  runs_executor: action('runs', RUNS_ABI, 'setSwapExecutor', 'Configuration manager (contract must be paused)', ['address']),
  runs_destinations: action('runs', RUNS_ABI, 'setRewardDestinations', 'Configuration manager (contract must be paused)', ['address', 'address', 'address']),
  rewards_reserve: action('rewards', REWARDS_ABI, 'setReserveTreasury', 'MATT Mine Treasury Safe (contract must be paused)', ['address']),
  rewards_recover_expired: action('rewards', REWARDS_ABI, 'recoverExpiredRewards', 'MATT Mine Treasury Safe', ['uint', 'board']),
  rewards_recover_unallocated: action('rewards', REWARDS_ABI, 'recoverUnallocatedRewards', 'MATT Mine Treasury Safe', ['matt']),
  matt_approve_reward_vault: action('matt', MATT_ABI, 'approve', 'MATT Mine Treasury Safe', ['matt'], (args) => [MATT_MINE_ADMIN_CONTRACTS.rewards, args[0]]),
  rewards_fund_vault: action('rewards', REWARDS_ABI, 'fundRewards', 'MATT Mine Treasury Safe', ['matt'])
});

export function listAdminContractActions() {
  return Object.entries(ACTIONS).map(([id, value]) => ({
    id,
    contract: value.contract,
    requiredSigner: value.requiredSigner,
    argumentTypes: value.argumentTypes
  }));
}

export function prepareAdminContractTransaction(input = {}) {
  return prepareAdminContractTransactions(input).at(-1);
}

export function prepareAdminContractTransactions(input = {}) {
  const actionId = String(input.action || '');
  const definition = ACTIONS[actionId];
  assertApi(definition, 400, 'unknown_contract_action', 'Unknown contract action.');
  const supplied = Array.isArray(input.arguments) ? input.arguments : [];
  assertApi(
    supplied.length === definition.argumentTypes.length,
    400,
    'contract_arguments_invalid',
    `This action requires ${definition.argumentTypes.length} argument(s).`
  );
  const normalizedArgs = definition.argumentTypes.map((type, index) => normalizeArgument(type, supplied[index]));
  const args = definition.mapArgs ? definition.mapArgs(normalizedArgs) : normalizedArgs;
  if (actionId === 'rewards_fund_vault') {
    return [
      buildTransaction({
        actionId,
        contract: 'matt',
        abi: MATT_ABI,
        functionName: 'approve',
        args: [MATT_MINE_ADMIN_CONTRACTS.rewards, args[0]],
        requiredSigner: definition.requiredSigner,
        purpose: 'Approve the reward vault to pull this exact MATT amount.'
      }),
      buildTransaction({
        actionId,
        contract: definition.contract,
        abi: definition.abi,
        functionName: definition.functionName,
        args,
        requiredSigner: definition.requiredSigner,
        purpose: 'Fund the reward vault immediately after the matching approval.'
      })
    ];
  }
  return [buildTransaction({
    actionId,
    contract: definition.contract,
    abi: definition.abi,
    functionName: definition.functionName,
    args,
    requiredSigner: definition.requiredSigner
  })];
}

function buildTransaction({
  actionId,
  contract,
  abi,
  functionName,
  args,
  requiredSigner,
  purpose = ''
}) {
  return {
    chainId: 2020,
    action: actionId,
    contract,
    to: MATT_MINE_ADMIN_CONTRACTS[contract],
    value: '0',
    data: encodeFunctionData({
      abi,
      functionName,
      args
    }),
    functionName,
    arguments: args.map(String),
    requiredSigner,
    safeAddress: MATT_MINE_ADMIN_CONTRACTS.safe,
    broadcast: false,
    ...(purpose ? { purpose } : {}),
    warning: 'Prepared only. Review the destination, calldata, signer role, and current contract state before signing.'
  };
}

export function createAdminSafeTransactionFile(transactionOrTransactions, createdAt = Date.now()) {
  const transactions = Array.isArray(transactionOrTransactions)
    ? transactionOrTransactions
    : [transactionOrTransactions];
  if (!transactions.length || transactions.some((transaction) => !transaction.requiredSigner.includes('Safe'))) return null;
  const primary = transactions.at(-1);
  return createSafeTransactionBuilderFile(transactions, {
    chainId: primary.chainId,
    createdAt,
    safeAddress: primary.safeAddress,
    name: `MATT Mine: ${primary.action}`,
    description: `Prepared by the MATT Mine Command Center for ${primary.requiredSigner}. Execute every transaction in order.`
  });
}

function action(contract, abi, functionName, requiredSigner, argumentTypes, mapArgs = null) {
  return { contract, abi, functionName, requiredSigner, argumentTypes, mapArgs };
}

function normalizeArgument(type, value) {
  if (type === 'address') {
    try {
      return getAddress(value);
    } catch {
      throw new ApiError(400, 'contract_address_invalid', 'A contract action address is invalid.');
    }
  }
  if (type === 'ron') {
    assertApi(typeof value === 'string' || typeof value === 'number', 400, 'ron_amount_invalid', 'Enter a RON amount.');
    try {
      const parsed = parseEther(String(value));
      assertApi(parsed > 0n, 400, 'ron_amount_invalid', 'RON amount must be greater than zero.');
      return parsed;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'ron_amount_invalid', 'Enter a valid RON amount with no more than 18 decimals.');
    }
  }
  if (type === 'matt') {
    try {
      const parsed = parseUnits(String(value), 18);
      assertApi(parsed > 0n, 400, 'matt_amount_invalid', 'MATT amount must be greater than zero.');
      return parsed;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(400, 'matt_amount_invalid', 'Enter a valid MATT amount with no more than 18 decimals.');
    }
  }
  if (type === 'uint') {
    assertApi(/^\d+$/.test(String(value)), 400, 'integer_invalid', 'Enter a non-negative whole number.');
    return BigInt(value);
  }
  if (type === 'board') {
    const board = String(value).toLowerCase();
    assertApi(['free', 'paid', '0', '1'].includes(board), 400, 'board_invalid', 'Board must be Free or Pass.');
    return board === 'paid' || board === '1' ? 1 : 0;
  }
  throw new ApiError(500, 'contract_argument_type_unknown', 'Unsupported contract argument type.');
}
