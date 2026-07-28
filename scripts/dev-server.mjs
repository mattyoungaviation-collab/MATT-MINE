import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileDatabase, PostgresDatabase } from '../server/database.js';
import { createProductionMattMineHttpServer } from '../server/production-http.js';
import { RoninPaymentVerifier, RONIN_PAYMENT_CONTRACTS } from '../server/payment-verifier.js';
import { DirectRoninNuggetPaymentVerifier } from '../server/nugget-payment-verifier.js';
import {
  JsonNuggetEconomyStore,
  PostgresNuggetEconomyStore
} from '../server/nugget-economy.js';
import { RoninRewardChain } from '../server/reward-chain.js';
import { RewardManager } from '../server/reward-manager.js';
import { MemoryRewardStore, PostgresRewardStore } from '../server/reward-store.js';
import { CompleteProductionMattMineService } from '../server/complete-production-service.js';
import { DailyArenaService } from '../server/arena-service.js';
import {
  RONIN_ARENA_DEPLOYMENT,
  RoninArenaChain
} from '../server/arena-chain.js';
import { MemoryArenaStore, PostgresArenaStore } from '../server/arena-store.js';
import { MATT_MINE_ADMIN_CONTRACTS } from '../server/admin-controls.js';
import {
  MemoryCompetitiveReplayStore,
  PostgresCompetitiveReplayStore
} from '../server/competitive-replay-store.js';
import { CompetitiveReplayService } from '../server/competitive-replay-service.js';
import { resolveCompetitionSnapshot } from '../src/game/competitionStudio.js';
import {
  DirectRoninRevivePaymentVerifier,
  HmacAdvertisementVerifier
} from '../server/external-verifiers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const dataFile = resolve(root, process.env.MATT_MINE_DATA_FILE || 'data/matt-mine-store.json');
const nuggetEconomyFile = resolve(
  root,
  process.env.MATT_MINE_NUGGET_ECONOMY_FILE || 'data/matt-mine-nugget-economy.json'
);
const databaseUrl = process.env.DATABASE_URL?.trim();
const mainnetTransactionsEnabled =
  process.env.MATT_MINE_MAINNET_TRANSACTIONS_ENABLED === 'true';
const nuggetPaymentsRequested =
  process.env.MATT_MINE_NUGGET_PAYMENTS_ENABLED === 'true';
const paymentVerifier = mainnetTransactionsEnabled
  ? new RoninPaymentVerifier({
      rpcUrl: process.env.RONIN_RPC_URL,
      confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3)
    })
  : null;
const nuggetPaymentVerifier = mainnetTransactionsEnabled && nuggetPaymentsRequested
  ? new DirectRoninNuggetPaymentVerifier({
      rpcUrl: process.env.RONIN_RPC_URL,
      confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3)
    })
  : null;
const database = databaseUrl
  ? await new PostgresDatabase(databaseUrl, {
      ssl: process.env.MATT_MINE_DATABASE_SSL === 'true',
      rejectUnauthorized: process.env.MATT_MINE_DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
      maxConnections: Number(process.env.MATT_MINE_DATABASE_POOL_SIZE || 10)
    }).init()
  : await new JsonFileDatabase(dataFile).init();
const nuggetEconomyStore = database.kind === 'postgresql'
  ? await new PostgresNuggetEconomyStore(database).init()
  : await new JsonNuggetEconomyStore(nuggetEconomyFile).init();
const rewardStore = database.kind === 'postgresql'
  ? await new PostgresRewardStore(database).init()
  : await new MemoryRewardStore().init();
const rewardManager = await new RewardManager({
  store: rewardStore,
  chain: new RoninRewardChain({ rpcUrl: process.env.RONIN_RPC_URL }),
  adminKey: process.env.MATT_MINE_ADMIN_KEY || '',
  approverKey: process.env.MATT_MINE_REWARD_APPROVER_KEY || '',
  publicationEnabled: process.env.MATT_MINE_REWARD_PUBLISHING_ENABLED === 'true',
  maxBoardMatt: Number(process.env.MATT_MINE_REWARD_MAX_BOARD_MATT || 100_000)
}).init();
const arenaContractAddress = process.env.MATT_MINE_ARENA_CONTRACT_ADDRESS?.trim();
const arenaReceiptSecret = process.env.MATT_MINE_ARENA_RECEIPT_SECRET || '';
const arenaLiveRequested = process.env.MATT_MINE_ARENA_LIVE === 'true';
const arenaEnabled = Boolean(arenaContractAddress && arenaReceiptSecret);
const arenaStore = arenaEnabled
  ? database.kind === 'postgresql'
    ? await new PostgresArenaStore(database).init()
    : await new MemoryArenaStore().init()
  : null;
const arenaService = arenaEnabled
  ? await new DailyArenaService({
      store: arenaStore,
      chain: new RoninArenaChain({
        contractAddress: arenaContractAddress,
        mattTokenAddress: process.env.MATT_MINE_ARENA_MATT_ADDRESS || RONIN_PAYMENT_CONTRACTS.matt,
        expectedContractAddress:
          process.env.MATT_MINE_ARENA_EXPECTED_CONTRACT_ADDRESS ||
          RONIN_ARENA_DEPLOYMENT.contract,
        runtimeCodeHash:
          process.env.MATT_MINE_ARENA_RUNTIME_CODE_HASH ||
          RONIN_ARENA_DEPLOYMENT.runtimeCodeHash,
        safeAddress:
          process.env.MATT_MINE_ARENA_SAFE_ADDRESS ||
          RONIN_ARENA_DEPLOYMENT.treasurySafe,
        emergencyPauserAddress:
          process.env.MATT_MINE_ARENA_PAUSER_ADDRESS ||
          RONIN_ARENA_DEPLOYMENT.emergencyPauser,
        temporaryDeployerAddress:
          process.env.MATT_MINE_ARENA_DEPLOYER_ADDRESS ||
          RONIN_ARENA_DEPLOYMENT.temporaryDeployer,
        requireEntriesPaused: !arenaLiveRequested,
        rpcUrl: process.env.RONIN_RPC_URL,
        confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3)
      }),
      receiptSecret: arenaReceiptSecret,
      seedSecret: process.env.MATT_MINE_ARENA_SEED_SECRET || arenaReceiptSecret,
      safeAddress: process.env.MATT_MINE_ARENA_SAFE_ADDRESS || MATT_MINE_ADMIN_CONTRACTS.safe,
      getTuning: async (day) => {
        const state = await database.read();
        const tuning = structuredClone(state.arenaTuningSchedule?.[day] || state.gameTuning.arena);
        tuning._competitionSnapshot = resolveCompetitionSnapshot(
          state.competitionStudio,
          'arena',
          Date.parse(`${day}T12:00:00.000Z`)
        );
        return tuning;
      },
      liveEnabled: arenaLiveRequested
    }).init()
  : null;
const competitiveReplaySecret =
  process.env.MATT_MINE_COMPETITIVE_REPLAY_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'local-matt-mine-competitive-replay-secret');
const competitiveReplayStore = database.kind === 'postgresql'
  ? await new PostgresCompetitiveReplayStore(database).init()
  : await new MemoryCompetitiveReplayStore().init();
const competitiveReplayValidator = competitiveReplaySecret.length >= 32
  ? await new CompetitiveReplayService({
      store: competitiveReplayStore,
      secret: competitiveReplaySecret
    }).init()
  : null;
const revivePaymentsRequested =
  process.env.MATT_MINE_REVIVE_PAYMENTS_ENABLED === 'true';
const revivePaymentVerifier = mainnetTransactionsEnabled && revivePaymentsRequested
  ? new DirectRoninRevivePaymentVerifier({
      rpcUrl: process.env.RONIN_RPC_URL,
      confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3),
      recipient:
        process.env.MATT_MINE_REVIVE_RECIPIENT_ADDRESS ||
        MATT_MINE_ADMIN_CONTRACTS.safe
    })
  : null;
const advertisementSecret = process.env.MATT_MINE_ADVERTISEMENT_HMAC_SECRET || '';
const advertisementProvider = process.env.MATT_MINE_ADVERTISEMENT_PROVIDER || '';
const advertisementVerifier =
  process.env.MATT_MINE_ADVERTISEMENT_REWARDS_ENABLED === 'true' &&
  advertisementSecret.length >= 32 &&
  advertisementProvider
    ? new HmacAdvertisementVerifier({
        secret: advertisementSecret,
        provider: advertisementProvider
      })
    : null;
const service = new CompleteProductionMattMineService(database, {
  publicOrigin: process.env.MATT_MINE_PUBLIC_ORIGIN || null,
  adminKey: process.env.MATT_MINE_ADMIN_KEY || '',
  mainnetTransactionsEnabled,
  paymentVerifier,
  rewardManager,
  arenaService,
  nuggetEconomyStore,
  nuggetPaymentVerifier,
  nuggetPaymentsEnabled: mainnetTransactionsEnabled && nuggetPaymentsRequested,
  competitiveReplayValidator,
  ...(revivePaymentVerifier && competitiveReplayValidator ? {
    revivePaymentVerifier,
    reviveEligibilityValidator: {
      validate: (input) => competitiveReplayValidator.validateDeath(input)
    }
  } : {}),
  ...(advertisementVerifier ? { advertisementVerifier } : {})
});
const server = createProductionMattMineHttpServer({ root, service });

server.listen(port, '0.0.0.0', () => {
  console.log(`MATT Mine v2.0 running at http://localhost:${port}`);
  console.log(`Ranked wallet network: ${service.config().chainName} (${service.config().chainId})`);
  console.log(`Mainnet transaction mode: ${mainnetTransactionsEnabled ? 'ENABLED (real RON)' : 'disabled'}`);
  console.log(`Nugget payments: ${service.nuggetPaymentsEnabled ? 'EXACT VERIFICATION ENABLED' : 'disabled by release blocker'}`);
  console.log(`Reward publication: ${rewardManager.publicationEnabled ? 'PILOT ENABLED' : 'DRY RUN'}`);
  console.log(`Daily Arena: ${arenaEnabled
    ? `exact deployment pinned (${arenaContractAddress}); deterministic replay ${arenaLiveRequested ? 'LIVE' : 'ready, live mode disabled'}`
    : 'disabled until contract + receipt secret are configured'}`);
  console.log(`Competitive replay: ${competitiveReplayValidator
    ? `ENABLED (${competitiveReplayStore.kind})`
    : 'disabled until MATT_MINE_COMPETITIVE_REPLAY_SECRET is configured'}`);
  console.log(`Paid revive verifier: ${revivePaymentVerifier ? 'EXACT RON TRANSFER ENABLED' : 'disabled'}`);
  console.log(`Advertisement verifier: ${advertisementVerifier ? `SIGNED ${advertisementProvider}` : 'disabled'}`);
  console.log(`Server data: ${database.kind}${databaseUrl ? '' : ` (${dataFile})`}`);
  console.log(`Nugget economy data: ${nuggetEconomyStore.kind}${databaseUrl ? '' : ` (${nuggetEconomyFile})`}`);
});

let closing = false;
function closeServer() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await nuggetEconomyStore.close();
    await competitiveReplayStore.close();
    await database.close();
    process.exit(0);
  });
}

process.once('SIGINT', closeServer);
process.once('SIGTERM', closeServer);
