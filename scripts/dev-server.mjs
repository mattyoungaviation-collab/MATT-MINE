import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileDatabase, PostgresDatabase } from '../server/database.js';
import { createProductionMattMineHttpServer } from '../server/production-http.js';
import { RoninPaymentVerifier, RONIN_PAYMENT_CONTRACTS } from '../server/payment-verifier.js';
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
  DirectRoninRevivePaymentVerifier
} from '../server/external-verifiers.js';
import { PaidCompetitionEligibilityPolicy } from '../server/eligibility.js';
import { NftMetadataService } from '../server/nft-metadata-service.js';
import { createSaigonChestKeeperFromEnvironment } from '../server/saigon-chest-keeper.js';
import { createNftGameplayServiceFromEnvironment } from '../server/nft-gameplay-service.js';
import { createNftV2AdminServiceFromEnvironment } from '../server/nft-v2-admin-service.js';
import { createEndlessSettlementServiceFromEnvironment } from '../server/endless-settlement-service.js';
import { nftRpcUrlFromEnvironment } from '../server/nft-rpc-url.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const packageMetadata = JSON.parse(
  await readFile(resolve(root, 'package.json'), 'utf8')
);
const appVersion = String(packageMetadata.version || 'unknown');
const port = Number(process.env.PORT || 4173);
const dataFile = resolve(root, process.env.MATT_MINE_DATA_FILE || 'data/matt-mine-store.json');
const databaseUrl = process.env.DATABASE_URL?.trim();
const roninRpcUrls = (process.env.RONIN_RPC_URLS || process.env.RONIN_RPC_URL || '')
  .split(',').map((value) => value.trim()).filter(Boolean);
const mainnetTransactionsEnabled =
  process.env.MATT_MINE_MAINNET_TRANSACTIONS_ENABLED === 'true';
const paymentVerifier = mainnetTransactionsEnabled
  ? new RoninPaymentVerifier({
      rpcUrls: roninRpcUrls,
      rpcTimeoutMs: Number(process.env.MATT_MINE_RPC_TIMEOUT_MS || 10_000),
      confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3)
    })
  : null;
const database = databaseUrl
  ? await new PostgresDatabase(databaseUrl, {
      ssl: process.env.MATT_MINE_DATABASE_SSL === 'true',
      rejectUnauthorized: process.env.MATT_MINE_DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
      maxConnections: Number(process.env.MATT_MINE_DATABASE_POOL_SIZE || 10),
      startupRetryAttempts: Number(process.env.MATT_MINE_DATABASE_STARTUP_RETRY_ATTEMPTS || 90),
      queryRetryAttempts: Number(process.env.MATT_MINE_DATABASE_QUERY_RETRY_ATTEMPTS || 5)
    }).init()
  : await new JsonFileDatabase(dataFile).init();
const initializeStore = (store, label) => database.kind === 'postgresql'
  ? database.retryTransient(
      () => store.init(),
      {
        maxAttempts: Number(process.env.MATT_MINE_DATABASE_STARTUP_RETRY_ATTEMPTS || 90),
        label
      }
    )
  : store.init();
const rewardStore = await initializeStore(
  database.kind === 'postgresql'
    ? new PostgresRewardStore(database)
    : new MemoryRewardStore(),
  'reward storage startup'
);
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
    ? await initializeStore(new PostgresArenaStore(database), 'Daily Arena storage startup')
    : await initializeStore(new MemoryArenaStore(), 'Daily Arena storage startup')
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
        rpcUrls: roninRpcUrls,
        rpcTimeoutMs: Number(process.env.MATT_MINE_RPC_TIMEOUT_MS || 10_000),
        confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3)
      }),
      receiptSecret: arenaReceiptSecret,
      seedSecret: process.env.MATT_MINE_ARENA_SEED_SECRET || arenaReceiptSecret,
      safeAddress: process.env.MATT_MINE_ARENA_SAFE_ADDRESS || MATT_MINE_ADMIN_CONTRACTS.safe,
      getPaidReviveState: async (runId) =>
        (await database.read()).arenaReviveRuns?.[runId] || null,
      getTuning: async () => {
        const state = await database.read();
        const tuning = structuredClone(state.gameTuning.arena);
        const competitionSnapshot = resolveCompetitionSnapshot(
          state.competitionStudio,
          'arena',
          Date.now()
        );
        const characterId = competitionSnapshot?.loadout?.characterId || 'matt';
        tuning._competitionSnapshot = competitionSnapshot;
        if (competitionSnapshot) {
          tuning.safeStartSeconds = competitionSnapshot.rules.safeStartSeconds;
          tuning.playerMaxHealth = competitionSnapshot.loadout.startingHealth;
          tuning.dynamiteStartAmmo = competitionSnapshot.loadout.startingDynamite;
          tuning.blasterEnergy = competitionSnapshot.loadout.blasterEnergy;
          tuning.disableRunUpgrades = competitionSnapshot.loadout.runUpgrades === false;
          tuning.maximumDrones = competitionSnapshot.loadout.maximumDrones;
        }
        tuning._competitionCharacter = structuredClone(
          state.expansionConfig?.characters?.[characterId] ||
          state.expansionConfig?.characters?.matt ||
          {}
        );
        return tuning;
      },
      liveEnabled: arenaLiveRequested
    }).init()
  : null;
const competitiveReplaySecret =
  process.env.MATT_MINE_COMPETITIVE_REPLAY_SECRET ||
  (process.env.NODE_ENV === 'production' ? '' : 'local-matt-mine-competitive-replay-secret');
const competitiveReplayStore = await initializeStore(
  database.kind === 'postgresql'
    ? new PostgresCompetitiveReplayStore(database)
    : new MemoryCompetitiveReplayStore(),
  'competitive replay storage startup'
);
const competitiveReplayValidator = competitiveReplaySecret.length >= 32
  ? await new CompetitiveReplayService({
      store: competitiveReplayStore,
      secret: competitiveReplaySecret,
      resolveRun: async (runId) => (await database.read()).runs?.[runId] || null
    }).init()
  : null;
const revivePaymentsRequested =
  process.env.MATT_MINE_REVIVE_PAYMENTS_ENABLED === 'true';
const revivePaymentVerifier = mainnetTransactionsEnabled && revivePaymentsRequested
  ? new DirectRoninRevivePaymentVerifier({
      rpcUrls: roninRpcUrls,
      rpcTimeoutMs: Number(process.env.MATT_MINE_RPC_TIMEOUT_MS || 10_000),
      confirmations: Number(process.env.MATT_MINE_PAYMENT_CONFIRMATIONS || 3),
      recipient:
        process.env.MATT_MINE_REVIVE_RECIPIENT_ADDRESS ||
        MATT_MINE_ADMIN_CONTRACTS.safe
    })
  : null;
const nftMetadataEnabled = process.env.MATT_MINE_NFT_ENABLED === 'true';
const nftRpcUrl = nftRpcUrlFromEnvironment();
const nftMetadataService = nftMetadataEnabled
  ? await new NftMetadataService({
      enabled: true,
      root,
      publicOrigin: process.env.MATT_MINE_NFT_PUBLIC_BASE_URL || process.env.MATT_MINE_PUBLIC_ORIGIN,
      chainId: Number(process.env.MATT_MINE_NFT_CHAIN_ID || 2020),
      rpcUrl: nftRpcUrl,
      timeoutMs: Number(process.env.MATT_MINE_RPC_TIMEOUT_MS || 10_000),
      minerDeploymentBlock: process.env.MATT_MINE_NFT_MINER_DEPLOYMENT_BLOCK || 59_628_599,
      equipmentDeploymentBlock: process.env.MATT_MINE_NFT_EQUIPMENT_DEPLOYMENT_BLOCK || 59_628_601,
      equipmentIndexChunkSize: Number(process.env.MATT_MINE_NFT_EQUIPMENT_INDEX_CHUNK_SIZE || 1_000),
      equipmentIndexRefreshMs: Number(process.env.MATT_MINE_NFT_EQUIPMENT_INDEX_REFRESH_MS || 5_000),
      equipmentIndexConfirmations: Number(process.env.MATT_MINE_NFT_EQUIPMENT_INDEX_CONFIRMATIONS || 12),
      equipmentIndexMaxChunks: Number(process.env.MATT_MINE_NFT_EQUIPMENT_INDEX_MAX_CHUNKS || 25),
      equipmentIndexStartupWaitMs: Number(process.env.MATT_MINE_NFT_EQUIPMENT_INDEX_STARTUP_WAIT_MS || 1_500),
      equipmentSnapshotTtlMs: Number(process.env.MATT_MINE_NFT_EQUIPMENT_SNAPSHOT_TTL_MS || 120_000),
      addresses: {
        miner: process.env.MATT_MINE_NFT_MINER_ADDRESS,
        equipment: process.env.MATT_MINE_NFT_EQUIPMENT_ADDRESS,
        loadout: process.env.MATT_MINE_NFT_LOADOUT_ADDRESS
      }
    }).init()
  : null;
const nftGameplayService = createNftGameplayServiceFromEnvironment(nftMetadataService, process.env, { rpcUrl: nftRpcUrl });
if (nftGameplayService) {
  const savedProtocol = (await database.read()).nftV2Protocol || {};
  const savedVersions = savedProtocol.mapVersions || {};
  if (savedProtocol.updatedAt > 0) {
    nftGameplayService.clearMapVersion('arena');
    nftGameplayService.clearMapVersion('paid');
  }
  for (const [mode, versionId] of Object.entries(savedVersions)) nftGameplayService.setMapVersion(mode, versionId);
  await nftGameplayService.init();
}
const nftV2AdminService = createNftV2AdminServiceFromEnvironment(nftGameplayService, process.env, { rpcUrl: nftRpcUrl });
if (nftV2AdminService) await nftV2AdminService.init();
const endlessSettlementService = createEndlessSettlementServiceFromEnvironment(process.env, { rpcUrl: nftRpcUrl });
if (endlessSettlementService) await endlessSettlementService.init();
const saigonChestKeeper = createSaigonChestKeeperFromEnvironment();
if (saigonChestKeeper) await saigonChestKeeper.init();
const service = new CompleteProductionMattMineService(database, {
  appVersion,
  buildCommit: process.env.RENDER_GIT_COMMIT || process.env.GIT_COMMIT || 'unknown',
  publicOrigin: process.env.MATT_MINE_PUBLIC_ORIGIN || null,
  walletConnectProjectId: process.env.VITE_WALLETCONNECT_PROJECT_ID || '',
  adminKey: process.env.MATT_MINE_ADMIN_KEY || '',
  adminWallets: (process.env.MATT_MINE_ADMIN_WALLETS || '').split(',').map((value) => value.trim()),
  eligibilityPolicy: new PaidCompetitionEligibilityPolicy({
    counselApproved: process.env.MATT_MINE_ELIGIBILITY_COUNSEL_APPROVED === 'true',
    rulesVersion: process.env.MATT_MINE_ELIGIBILITY_RULES_VERSION || '',
    rulesHash: process.env.MATT_MINE_ELIGIBILITY_RULES_SHA256 || '',
    rulesUrl: process.env.MATT_MINE_ELIGIBILITY_RULES_URL || '',
    publicModes: (process.env.MATT_MINE_PUBLIC_PAID_MODES || '').split(',').map((value) => value.trim()),
    receiptSecret: process.env.MATT_MINE_ELIGIBILITY_RECEIPT_SECRET || arenaReceiptSecret,
    allowedWallets: (process.env.MATT_MINE_ELIGIBLE_PAID_WALLETS || '').split(',').map((value) => value.trim())
  }),
  mainnetTransactionsEnabled,
  paymentVerifier,
  rewardManager,
  arenaService,
  competitiveReplayValidator,
  nftMetadataService,
  nftGameplayService,
  nftV2AdminService,
  endlessRewardSettler: endlessSettlementService,
  operationsStage: process.env.MATT_MINE_OPERATIONS_STAGE || 'public',
  operationsMonitorCacheMs: Number(process.env.MATT_MINE_OPERATIONS_CACHE_MS || 20_000),
  ...(revivePaymentVerifier && competitiveReplayValidator ? {
    revivePaymentVerifier,
    reviveEligibilityValidator: {
      validate: (input) => competitiveReplayValidator.validateDeath(input)
    }
  } : {}),
});
const server = createProductionMattMineHttpServer({ root, service });

server.listen(port, '0.0.0.0', () => {
  console.log(`MATT Mine v${appVersion} running at http://localhost:${port}`);
  console.log(`Ranked wallet network: ${service.config().chainName} (${service.config().chainId})`);
  console.log(`Mainnet transaction mode: ${mainnetTransactionsEnabled ? 'ENABLED (real RON)' : 'disabled'}`);
  console.log(`Reward publication: ${rewardManager.publicationEnabled ? 'PILOT ENABLED' : 'DRY RUN'}`);
  console.log(`Daily Arena: ${arenaEnabled
    ? `exact deployment pinned (${arenaContractAddress}); deterministic replay ${arenaLiveRequested ? 'LIVE' : 'ready, live mode disabled'}`
    : 'disabled until contract + receipt secret are configured'}`);
  console.log(`Competitive replay: ${competitiveReplayValidator
    ? `ENABLED (${competitiveReplayStore.kind})`
    : 'disabled until MATT_MINE_COMPETITIVE_REPLAY_SECRET is configured'}`);
  console.log(`Paid revive verifier: ${revivePaymentVerifier ? 'EXACT RON TRANSFER ENABLED' : 'disabled'}`);
  console.log(`NFT metadata: ${nftMetadataService ? `ENABLED (chain ${nftMetadataService.chainId})` : 'disabled'}`);
  console.log(`NFT gameplay: ${nftGameplayService ? 'ENABLED (Ronin V2)' : 'disabled'}`);
  console.log(`NFT V2 Admin controls: ${nftV2AdminService ? 'ENABLED' : 'disabled'}`);
  console.log(`Saigon chest keeper: ${saigonChestKeeper ? 'ENABLED' : 'disabled'}`);
  console.log(`Server data: ${database.kind}${databaseUrl ? '' : ` (${dataFile})`}`);
});

let closing = false;
function closeServer() {
  if (closing) return;
  closing = true;
  saigonChestKeeper?.close();
  if (process.env.NODE_ENV === 'test') {
    server.closeAllConnections?.();
    process.exit(0);
  }
  server.close(async () => {
    await competitiveReplayStore.close();
    await database.close();
    process.exit(0);
  });
  server.closeIdleConnections?.();
  const forceCloseTimer = setTimeout(() => server.closeAllConnections?.(), 250);
  forceCloseTimer.unref();
}

process.once('SIGINT', closeServer);
process.once('SIGTERM', closeServer);
