import { getAddress } from 'viem';
import { ApiError, assertApi } from './errors.js';
import { createRoninReadClient } from './ronin-rpc.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;

export class DirectRoninTransferVerifier {
  constructor(options = {}) {
    this.confirmations = positiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 120_000);
    const rpc = options.client ? null : createRoninReadClient({
      urls: options.rpcUrls || options.rpcUrl,
      timeoutMs: options.rpcTimeoutMs
    });
    this.client = options.client || rpc.client;
  }

  transactionForTransfer({ amountAtomic, recipient }) {
    return { to: getAddress(recipient), value: `0x${BigInt(amountAtomic).toString(16)}`, data: '0x' };
  }

  async verifyExactTransfer(transactionHash, expectedAddress, transfer) {
    assertApi(TRANSACTION_HASH_PATTERN.test(String(transactionHash || '')), 400, 'invalid_transaction_hash', 'A valid Ronin transaction hash is required.');
    const hash = transactionHash.toLowerCase();
    const expectedPlayer = getAddress(expectedAddress);
    const expectedRecipient = getAddress(transfer.recipient);
    const expectedAmount = BigInt(transfer.amountAtomic);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({ hash, confirmations: this.confirmations, timeout: this.receiptTimeoutMs });
    } catch {
      throw new ApiError(409, 'transaction_confirming', 'The payment is not confirmed yet. Try again shortly.');
    }
    assertApi(receipt.status === 'success', 422, 'transaction_reverted', 'The payment transaction reverted.');
    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, expectedPlayer), 403, 'payment_wallet_mismatch', 'This payment was sent by another wallet.');
    assertApi(sameAddress(transaction.to, expectedRecipient) && sameAddress(receipt.to, expectedRecipient), 422, 'wrong_payment_recipient', 'The RON payment recipient does not match.');
    assertApi(transaction.value === expectedAmount, 422, 'payment_amount_mismatch', 'The RON payment amount must match exactly.');
    assertApi(!transaction.input || transaction.input === '0x', 422, 'invalid_payment_call', 'The RON payment must be a direct transfer.');
    const block = typeof this.client.getBlock === 'function' ? await this.client.getBlock({ blockNumber: receipt.blockNumber }) : null;
    return {
      transactionHash: hash,
      blockNumber: String(receipt.blockNumber),
      transactionBlockAt: block ? Number(block.timestamp) * 1000 : 0,
      asset: 'RON',
      amountAtomic: String(transaction.value),
      recipient: expectedRecipient.toLowerCase()
    };
  }
}

function sameAddress(left, right) {
  try { return getAddress(left) === getAddress(right); } catch { return false; }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
