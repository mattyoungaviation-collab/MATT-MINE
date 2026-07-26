import {
  createPublicClient,
  encodeFunctionData,
  getAddress,
  http
} from 'viem';
import { ronin } from 'viem/chains';
import {
  MATT_TOKEN_ADDRESS,
  REWARD_CHAIN_ID,
  REWARD_CONTRACT_ADDRESS
} from './reward-plan.js';
import { assertApi } from './errors.js';

export const REWARDS_ABI = [
  {
    type: 'function',
    name: 'publishRewardEpoch',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'board', type: 'uint8' },
      { name: 'merkleRoot', type: 'bytes32' },
      { name: 'totalMatt', type: 'uint256' },
      { name: 'claimDeadline', type: 'uint64' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'fundRewards',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'mattAmount', type: 'uint256' }],
    outputs: []
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'board', type: 'uint8' },
      { name: 'mattAmount', type: 'uint256' },
      { name: 'proof', type: 'bytes32[]' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'getEpoch',
    stateMutability: 'view',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'board', type: 'uint8' }
    ],
    outputs: [{
      type: 'tuple',
      components: [
        { name: 'merkleRoot', type: 'bytes32' },
        { name: 'totalMatt', type: 'uint256' },
        { name: 'claimedMatt', type: 'uint256' },
        { name: 'claimDeadline', type: 'uint64' },
        { name: 'published', type: 'bool' },
        { name: 'closed', type: 'bool' }
      ]
    }]
  },
  {
    type: 'function',
    name: 'isClaimed',
    stateMutability: 'view',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'board', type: 'uint8' },
      { name: 'player', type: 'address' }
    ],
    outputs: [{ type: 'bool' }]
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
    name: 'totalReservedMatt',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint256' }]
  }
];

const ERC20_ABI = [
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' }
    ],
    outputs: [{ type: 'bool' }]
  },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }]
  }
];

export class RoninRewardChain {
  constructor(options = {}) {
    this.rewardsAddress = getAddress(options.rewardsAddress || REWARD_CONTRACT_ADDRESS);
    this.mattAddress = getAddress(options.mattAddress || MATT_TOKEN_ADDRESS);
    this.client = options.client || createPublicClient({
      chain: ronin,
      transport: http(options.rpcUrl || 'https://api.roninchain.com/rpc')
    });
  }

  publicConfig() {
    return {
      chainId: REWARD_CHAIN_ID,
      rewardsContract: this.rewardsAddress,
      mattToken: this.mattAddress,
      explorerUrl: 'https://explorer.roninchain.com'
    };
  }

  async publicationTransactions(plan) {
    const amount = BigInt(plan.allocatedRaw);
    const [vaultBalance, reserved] = await Promise.all([
      this.client.readContract({
        address: this.mattAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.rewardsAddress]
      }),
      this.client.readContract({
        address: this.rewardsAddress,
        abi: REWARDS_ABI,
        functionName: 'totalReservedMatt'
      })
    ]);
    const available = vaultBalance > reserved ? vaultBalance - reserved : 0n;
    const shortfall = amount > available ? amount - available : 0n;
    const transactions = [];
    if (shortfall > 0n) {
      transactions.push({
        purpose: 'Approve the reward vault to pull the exact pilot allocation',
        to: this.mattAddress,
        value: '0x0',
        data: encodeFunctionData({
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [this.rewardsAddress, shortfall]
        })
      });
      transactions.push({
        purpose: 'Fund the reward vault with the exact pilot allocation',
        to: this.rewardsAddress,
        value: '0x0',
        data: encodeFunctionData({
          abi: REWARDS_ABI,
          functionName: 'fundRewards',
          args: [shortfall]
        })
      });
    }
    transactions.push({
      purpose: 'Publish the immutable weekly Merkle root',
      to: this.rewardsAddress,
      value: '0x0',
      data: encodeFunctionData({
        abi: REWARDS_ABI,
        functionName: 'publishRewardEpoch',
        args: [
          BigInt(plan.epoch),
          plan.board,
          plan.merkleRoot,
          amount,
          BigInt(plan.claimDeadline)
        ]
      })
    });
    return {
      transactions,
      vault: {
        balanceRaw: String(vaultBalance),
        reservedRaw: String(reserved),
        availableRaw: String(available),
        fundingShortfallRaw: String(shortfall)
      }
    };
  }

  claimTransaction(reward) {
    return {
      to: this.rewardsAddress,
      value: '0x0',
      data: encodeFunctionData({
        abi: REWARDS_ABI,
        functionName: 'claim',
        args: [
          BigInt(reward.epoch),
          reward.board,
          BigInt(reward.amountRaw),
          reward.proof
        ]
      })
    };
  }

  async epochStatus(plan, playerAddress = null) {
    const epoch = await this.client.readContract({
      address: this.rewardsAddress,
      abi: REWARDS_ABI,
      functionName: 'getEpoch',
      args: [BigInt(plan.epoch), plan.board]
    });
    const paused = await this.client.readContract({
      address: this.rewardsAddress,
      abi: REWARDS_ABI,
      functionName: 'paused'
    });
    const published = epoch.published === true &&
      String(epoch.merkleRoot).toLowerCase() === plan.merkleRoot.toLowerCase() &&
      BigInt(epoch.totalMatt) === BigInt(plan.allocatedRaw) &&
      BigInt(epoch.claimDeadline) === BigInt(plan.claimDeadline);
    let claimed = false;
    if (playerAddress && published) {
      claimed = await this.client.readContract({
        address: this.rewardsAddress,
        abi: REWARDS_ABI,
        functionName: 'isClaimed',
        args: [BigInt(plan.epoch), plan.board, getAddress(playerAddress)]
      });
    }
    return {
      published,
      claimed,
      paused: paused === true,
      closed: epoch.closed === true,
      claimedRaw: String(epoch.claimedMatt),
      claimDeadline: Number(epoch.claimDeadline)
    };
  }

  async assertClaimable(plan, playerAddress) {
    const status = await this.epochStatus(plan, playerAddress);
    assertApi(status.published, 409, 'reward_not_published', 'This reward epoch is not published on Ronin yet.');
    assertApi(!status.paused, 503, 'reward_claims_paused', 'MATT reward claims are currently paused.');
    assertApi(!status.closed, 410, 'reward_epoch_closed', 'This reward epoch is closed.');
    assertApi(!status.claimed, 409, 'reward_already_claimed', 'This wallet already claimed this reward.');
    assertApi(status.claimDeadline >= Math.floor(Date.now() / 1000), 410, 'reward_claim_expired', 'This reward claim expired.');
    return status;
  }
}
