import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseEventLogs,
  parseUnits
} from 'viem';
import { ApiError, assertApi } from './errors.js';
import { MATT_TOKEN_ADDRESS, REWARD_CHAIN_ID, REWARD_TREASURY_ADDRESS } from './reward-plan.js';
import { createRoninReadClient } from './ronin-rpc.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const MATT_DECIMALS = 18;

const MATT_ABI = Object.freeze([
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }]
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'string' }]
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }]
  },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' }
    ],
    outputs: [{ name: '', type: 'bool' }]
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
]);

export class EndlessMattPaymentVerifier {
  constructor(options = {}) {
    this.chainId = REWARD_CHAIN_ID;
    this.token = getAddress(MATT_TOKEN_ADDRESS);
    this.recipient = getAddress(REWARD_TREASURY_ADDRESS);
    this.decimals = MATT_DECIMALS;
    this.confirmations = positiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 120_000);
    const rpc = options.client ? null : createRoninReadClient({
      urls: options.rpcUrls || options.rpcUrl,
      timeoutMs: options.rpcTimeoutMs
    });
    this.client = options.client || rpc.client;
    this.ready = false;
  }

  async init() {
    const [chainId, code, name, symbol, decimals] = await Promise.all([
      this.client.getChainId(),
      this.client.getCode({ address: this.token }),
      this.client.readContract({ address: this.token, abi: MATT_ABI, functionName: 'name' }),
      this.client.readContract({ address: this.token, abi: MATT_ABI, functionName: 'symbol' }),
      this.client.readContract({ address: this.token, abi: MATT_ABI, functionName: 'decimals' })
    ]);
    assertApi(Number(chainId) === this.chainId, 503, 'endless_payment_wrong_chain', 'The Endless payment verifier is not connected to Ronin Mainnet.');
    assertApi(code && code !== '0x', 503, 'endless_payment_token_missing', 'The trusted MATT token contract is not deployed on this RPC.');
    assertApi(String(name) === 'Matt' && String(symbol) === 'MATT' && Number(decimals) === this.decimals, 503, 'endless_payment_token_mismatch', 'The configured Endless payment token is not the trusted MATT contract.');
    this.ready = true;
    return this;
  }

  publicStatus() {
    return {
      configured: this.ready,
      chainId: this.chainId,
      chainName: 'Ronin Mainnet',
      asset: 'MATT',
      token: this.token,
      recipient: this.recipient,
      decimals: this.decimals,
      confirmations: this.confirmations,
      routing: '100% of the Endless entry fee is transferred directly to the MATT Mine Treasury Safe.',
      verification: 'The server verifies the exact token, payer, recipient, amount, successful receipt, Transfer event, confirmations, and one-time use before creating a run.'
    };
  }

  transactionForPayment(mattPrice) {
    const amountRaw = exactMattAmount(mattPrice, this.decimals);
    return {
      to: this.token,
      value: '0x0',
      data: encodeFunctionData({
        abi: MATT_ABI,
        functionName: 'transfer',
        args: [this.recipient, amountRaw]
      })
    };
  }

  async verifyPayment({ transactionHash, address, mattPrice }) {
    assertApi(this.ready, 503, 'endless_payment_verifier_not_ready', 'Paid Endless entry is closed until the MATT verifier passes startup checks.');
    assertApi(TRANSACTION_HASH_PATTERN.test(String(transactionHash || '')), 400, 'invalid_transaction_hash', 'A valid Ronin transaction hash is required.');
    const hash = String(transactionHash).toLowerCase();
    const payer = getAddress(address);
    const amountRaw = exactMattAmount(mattPrice, this.decimals);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.receiptTimeoutMs
      });
    } catch {
      throw new ApiError(409, 'transaction_confirming', 'The MATT entry payment is not confirmed yet. Try again shortly.');
    }
    assertApi(receipt.status === 'success', 422, 'transaction_reverted', 'The MATT entry payment reverted.');
    assertApi(sameAddress(receipt.to, this.token), 422, 'wrong_payment_token', 'The payment receipt does not target the trusted MATT token.');
    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, payer), 403, 'payment_wallet_mismatch', 'This MATT payment was sent by another wallet.');
    assertApi(sameAddress(transaction.to, this.token), 422, 'wrong_payment_token', 'The payment did not call the trusted MATT token.');
    assertApi(BigInt(transaction.value || 0) === 0n, 422, 'invalid_payment_value', 'The MATT payment must not include RON value.');

    let decoded;
    try {
      decoded = decodeFunctionData({ abi: MATT_ABI, data: transaction.input || transaction.data || '0x' });
    } catch {
      throw new ApiError(422, 'invalid_payment_call', 'The MATT payment must be an exact token transfer.');
    }
    assertApi(decoded.functionName === 'transfer', 422, 'invalid_payment_call', 'The MATT payment must be an exact token transfer.');
    assertApi(sameAddress(decoded.args?.[0], this.recipient), 422, 'wrong_payment_recipient', 'The MATT entry fee must go to the approved Treasury Safe.');
    assertApi(BigInt(decoded.args?.[1] ?? -1) === amountRaw, 422, 'payment_amount_mismatch', 'The MATT entry payment amount must match the active Admin price exactly.');

    const transferEvents = parseEventLogs({ abi: MATT_ABI, logs: receipt.logs || [], eventName: 'Transfer', strict: false });
    const transfer = transferEvents.find((event) =>
      sameAddress(event.address, this.token) &&
      sameAddress(event.args?.from, payer) &&
      sameAddress(event.args?.to, this.recipient) &&
      BigInt(event.args?.value ?? -1) === amountRaw
    );
    assertApi(transfer, 422, 'payment_transfer_event_missing', 'The confirmed transaction did not emit the exact trusted MATT transfer.');
    const block = typeof this.client.getBlock === 'function'
      ? await this.client.getBlock({ blockNumber: receipt.blockNumber })
      : null;
    const logIndex = Number(transfer.logIndex ?? 0);
    return {
      key: `${hash}:${logIndex}`,
      transactionHash: hash,
      logIndex,
      blockNumber: String(receipt.blockNumber),
      transactionBlockAt: block ? Number(block.timestamp) * 1_000 : 0,
      chainId: this.chainId,
      asset: 'MATT',
      token: this.token.toLowerCase(),
      payer: payer.toLowerCase(),
      recipient: this.recipient.toLowerCase(),
      decimals: this.decimals,
      amountMatt: Number(mattPrice),
      amountRaw: amountRaw.toString(),
      confirmations: this.confirmations
    };
  }
}

function exactMattAmount(value, decimals) {
  const price = Number(value);
  assertApi(Number.isSafeInteger(price) && price > 0 && price <= 10_000_000, 422, 'endless_entry_price_invalid', 'The active Endless MATT entry price is invalid.');
  return parseUnits(String(price), decimals);
}

function sameAddress(left, right) {
  try { return getAddress(left) === getAddress(right); } catch { return false; }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export { MATT_ABI as ENDLESS_MATT_ABI };
