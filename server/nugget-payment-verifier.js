import {
  createPublicClient,
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  http,
  parseEventLogs
} from 'viem';
import { ronin } from 'viem/chains';
import { ApiError, assertApi } from './errors.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

const ERC20_TRANSFER_ABI = [
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false }
    ]
  }
];

export class DirectRoninNuggetPaymentVerifier {
  constructor(options = {}) {
    this.confirmations = safePositiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = safePositiveInteger(options.receiptTimeoutMs, 120_000);
    this.client = options.client || createPublicClient({
      chain: ronin,
      transport: http(options.rpcUrl || 'https://api.roninchain.com/rpc')
    });
  }

  transactionForQuote(quote) {
    const amount = BigInt(quote.amountAtomic);
    const recipient = getAddress(quote.recipient);
    if (quote.asset === 'RON') {
      return {
        to: recipient,
        value: toQuantityHex(amount),
        data: '0x'
      };
    }
    assertApi(quote.asset === 'MATT', 422, 'payment_asset_invalid', 'The quote uses an unsupported payment asset.');
    return {
      to: getAddress(quote.mattTokenAddress),
      value: '0x0',
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [recipient, amount]
      })
    };
  }

  async verifyExactTransfer(transactionHash, expectedAddress, quote) {
    assertApi(
      typeof transactionHash === 'string' && TRANSACTION_HASH_PATTERN.test(transactionHash),
      400,
      'invalid_transaction_hash',
      'A valid Ronin transaction hash is required.'
    );
    const hash = transactionHash.toLowerCase();
    const expectedPlayer = getAddress(expectedAddress);
    const expectedRecipient = getAddress(quote.recipient);
    const expectedAmount = BigInt(quote.amountAtomic);
    assertApi(expectedAmount > 0n, 422, 'payment_amount_invalid', 'The quote payment amount is invalid.');

    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.receiptTimeoutMs
      });
    } catch {
      throw new ApiError(409, 'transaction_confirming', 'The payment is not confirmed yet. Try again shortly.');
    }
    assertApi(receipt.status === 'success', 422, 'transaction_reverted', 'The payment transaction reverted.');

    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, expectedPlayer), 403, 'payment_wallet_mismatch', 'This payment was sent by another wallet.');

    if (quote.asset === 'RON') {
      assertApi(sameAddress(transaction.to, expectedRecipient), 422, 'wrong_payment_recipient', 'The RON payment recipient does not match the quote.');
      assertApi(sameAddress(receipt.to, expectedRecipient), 422, 'wrong_payment_recipient', 'The confirmed RON payment recipient does not match the quote.');
      assertApi(transaction.value === expectedAmount, 422, 'payment_amount_mismatch', 'The RON payment amount must exactly match the quote.');
      assertApi(!transaction.input || transaction.input === '0x', 422, 'invalid_payment_call', 'The RON payment must be a direct transfer.');
      return {
        transactionHash: hash,
        blockNumber: String(receipt.blockNumber),
        asset: 'RON',
        amountAtomic: String(transaction.value),
        recipient: expectedRecipient.toLowerCase()
      };
    }

    assertApi(quote.asset === 'MATT', 422, 'payment_asset_invalid', 'The quote uses an unsupported payment asset.');
    const mattToken = getAddress(quote.mattTokenAddress);
    assertApi(sameAddress(transaction.to, mattToken), 422, 'wrong_payment_contract', 'The payment was not sent to the approved MATT token contract.');
    assertApi(transaction.value === 0n, 422, 'unexpected_ron_value', 'A MATT transfer must not include RON.');

    let decoded;
    try {
      decoded = decodeFunctionData({ abi: ERC20_TRANSFER_ABI, data: transaction.input });
    } catch {
      throw new ApiError(422, 'invalid_payment_call', 'The transaction did not call the approved MATT transfer function.');
    }
    assertApi(decoded.functionName === 'transfer', 422, 'invalid_payment_call', 'The transaction did not call the approved MATT transfer function.');
    assertApi(sameAddress(decoded.args[0], expectedRecipient), 422, 'wrong_payment_recipient', 'The MATT payment recipient does not match the quote.');
    assertApi(decoded.args[1] === expectedAmount, 422, 'payment_amount_mismatch', 'The MATT payment amount must exactly match the quote.');

    const events = parseEventLogs({
      abi: ERC20_TRANSFER_ABI,
      logs: receipt.logs.filter((log) => sameAddress(log.address, mattToken)),
      eventName: 'Transfer',
      strict: true
    });
    const transfer = events.find((entry) =>
      sameAddress(entry.args.from, expectedPlayer) &&
      sameAddress(entry.args.to, expectedRecipient) &&
      entry.args.value === expectedAmount
    );
    assertApi(transfer, 422, 'payment_event_missing', 'The confirmed transaction did not transfer the quoted MATT amount to the approved recipient.');

    return {
      transactionHash: hash,
      blockNumber: String(receipt.blockNumber),
      logIndex: transfer.logIndex,
      asset: 'MATT',
      amountAtomic: String(transfer.args.value),
      recipient: expectedRecipient.toLowerCase(),
      tokenAddress: mattToken.toLowerCase()
    };
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
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
