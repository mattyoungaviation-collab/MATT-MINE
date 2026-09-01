import {
  decodeFunctionData,
  encodeFunctionData,
  getAddress,
  parseEventLogs
} from 'viem';
import { ApiError, assertApi } from './errors.js';
import { createRoninReadClient } from './ronin-rpc.js';
import {
  CONSUMABLE_TREASURY_ADDRESS,
  MATT_CRYSTAL_TOKEN_ADDRESS
} from '../src/game/consumables.js';

const TRANSACTION_HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const CRYSTAL_DECIMALS = 18;

const CRYSTAL_ABI = Object.freeze([
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  {
    type: 'function',
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }],
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
]);

export class ConsumableCrystalPaymentVerifier {
  constructor(options = {}) {
    this.chainId = 2020;
    this.token = getAddress(options.token || MATT_CRYSTAL_TOKEN_ADDRESS);
    this.recipient = getAddress(options.recipient || CONSUMABLE_TREASURY_ADDRESS);
    this.decimals = CRYSTAL_DECIMALS;
    this.confirmations = positiveInteger(options.confirmations, 3);
    this.receiptTimeoutMs = positiveInteger(options.receiptTimeoutMs, 120_000);
    const rpc = options.client ? null : createRoninReadClient({
      urls: options.rpcUrls || options.rpcUrl,
      timeoutMs: options.rpcTimeoutMs
    });
    this.client = options.client || rpc.client;
    this.ready = options.skipInitialization === true;
  }

  async init() {
    const [chainId, code, name, symbol, decimals] = await Promise.all([
      this.client.getChainId(),
      this.client.getCode({ address: this.token }),
      this.client.readContract({ address: this.token, abi: CRYSTAL_ABI, functionName: 'name' }),
      this.client.readContract({ address: this.token, abi: CRYSTAL_ABI, functionName: 'symbol' }),
      this.client.readContract({ address: this.token, abi: CRYSTAL_ABI, functionName: 'decimals' })
    ]);
    assertApi(Number(chainId) === this.chainId, 503, 'consumable_payment_wrong_chain', 'The Consumables verifier is not connected to Ronin Mainnet.');
    assertApi(code && code !== '0x', 503, 'consumable_payment_token_missing', 'The trusted MATT CRYSTALS token is not deployed on this RPC.');
    assertApi(
      String(name) === 'MATT CRYSTALS' && String(symbol) === 'CRYSTALS' && Number(decimals) === this.decimals,
      503,
      'consumable_payment_token_mismatch',
      'The configured Consumables token is not the trusted MATT CRYSTALS contract.'
    );
    this.ready = true;
    return this;
  }

  publicStatus() {
    return {
      configured: this.ready,
      chainId: this.chainId,
      chainName: 'Ronin Mainnet',
      asset: 'MATT CRYSTALS',
      token: this.token,
      recipient: this.recipient,
      decimals: this.decimals,
      confirmations: this.confirmations,
      routing: '100% of every Consumables purchase is transferred directly to the MATT Mine Treasury.'
    };
  }

  transactionForPayment(amountRaw) {
    const amount = exactRawAmount(amountRaw);
    return {
      to: this.token,
      value: '0x0',
      data: encodeFunctionData({
        abi: CRYSTAL_ABI,
        functionName: 'transfer',
        args: [this.recipient, amount]
      })
    };
  }

  async verifyPayment({ transactionHash, address, amountRaw }) {
    assertApi(this.ready, 503, 'consumable_payment_verifier_not_ready', 'Consumable purchases are closed until the Crystal verifier passes startup checks.');
    assertApi(TRANSACTION_HASH_PATTERN.test(String(transactionHash || '')), 400, 'invalid_transaction_hash', 'A valid Ronin transaction hash is required.');
    const hash = String(transactionHash).toLowerCase();
    const payer = getAddress(address);
    const amount = exactRawAmount(amountRaw);
    let receipt;
    try {
      receipt = await this.client.waitForTransactionReceipt({
        hash,
        confirmations: this.confirmations,
        timeout: this.receiptTimeoutMs
      });
    } catch {
      throw new ApiError(409, 'transaction_confirming', 'The MATT CRYSTALS payment is not confirmed yet. Try again shortly.');
    }
    assertApi(receipt.status === 'success', 422, 'transaction_reverted', 'The MATT CRYSTALS payment reverted.');
    assertApi(sameAddress(receipt.to, this.token), 422, 'wrong_payment_token', 'The purchase did not target the trusted MATT CRYSTALS token.');
    const transaction = await this.client.getTransaction({ hash });
    assertApi(sameAddress(transaction.from, payer), 403, 'payment_wallet_mismatch', 'This Consumables purchase was paid by another wallet.');
    assertApi(sameAddress(transaction.to, this.token), 422, 'wrong_payment_token', 'The purchase did not call the trusted MATT CRYSTALS token.');
    assertApi(BigInt(transaction.value || 0) === 0n, 422, 'invalid_payment_value', 'The Consumables purchase must not include RON value.');

    let decoded;
    try {
      decoded = decodeFunctionData({ abi: CRYSTAL_ABI, data: transaction.input || transaction.data || '0x' });
    } catch {
      throw new ApiError(422, 'invalid_payment_call', 'The Consumables purchase must be an exact token transfer.');
    }
    assertApi(decoded.functionName === 'transfer', 422, 'invalid_payment_call', 'The Consumables purchase must be an exact token transfer.');
    assertApi(sameAddress(decoded.args?.[0], this.recipient), 422, 'wrong_payment_recipient', 'The Consumables payment must go to the approved Treasury.');
    assertApi(BigInt(decoded.args?.[1] ?? -1) === amount, 422, 'payment_amount_mismatch', 'The Consumables payment amount must match the quoted price exactly.');

    const transfers = parseEventLogs({ abi: CRYSTAL_ABI, logs: receipt.logs || [], eventName: 'Transfer', strict: false });
    const transfer = transfers.find((event) =>
      sameAddress(event.address, this.token) &&
      sameAddress(event.args?.from, payer) &&
      sameAddress(event.args?.to, this.recipient) &&
      BigInt(event.args?.value ?? -1) === amount
    );
    assertApi(transfer, 422, 'payment_transfer_event_missing', 'The confirmed transaction did not emit the exact MATT CRYSTALS transfer.');
    const block = typeof this.client.getBlock === 'function'
      ? await this.client.getBlock({ blockNumber: receipt.blockNumber })
      : null;
    return {
      transactionHash: hash,
      logIndex: Number(transfer.logIndex ?? 0),
      blockNumber: String(receipt.blockNumber),
      transactionBlockAt: block ? Number(block.timestamp) * 1_000 : 0,
      token: this.token.toLowerCase(),
      payer: payer.toLowerCase(),
      recipient: this.recipient.toLowerCase(),
      amountRaw: amount.toString()
    };
  }
}

function exactRawAmount(value) {
  const amount = BigInt(String(value || '0'));
  assertApi(amount > 0n, 422, 'consumable_price_invalid', 'The active Consumables price is invalid.');
  return amount;
}

function sameAddress(left, right) {
  try { return getAddress(left) === getAddress(right); } catch { return false; }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

export { CRYSTAL_ABI as CONSUMABLE_CRYSTAL_ABI };
