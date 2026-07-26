import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileDatabase, PostgresDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { RoninPaymentVerifier, RONIN_PAYMENT_CONTRACTS } from '../server/payment-verifier.js';
import { RoninRewardChain } from '../server/reward-chain.js';
import { RewardManager } from '../server/reward-manager.js';
import { MemoryRewardStore, PostgresRewardStore } from '../server/reward-store.js';
import { MattMineService } from '../server/service.js';
import { DailyArenaService } from '../server/arena-service.js';
import {
  RONIN_ARENA_DEPLOYMENT,
  RoninArenaChain
} from '../server/arena-chain.js';
import { MemoryArenaStore, PostgresArenaStore } from '../server/arena-store.js';
import { MATT_MINE_ADMIN_CONTRACTS } from '../server/admin-controls.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const dataFile = resolve(root, process.env.MATT_MINE_DATA_FILE || 'data/matt-mine-store.json');
const databaseUrl = process.env.DATABASE_URL?.trim();
const mainnetTransactionsEnabled =
  process.env.MATT_MINE_MAINNET_TRANSACTIONS_ENABLED === 'true';
const paymentVerifier = mainnetTransactionsEnabled
  ? new RoninPaymentVerifier({
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
      liveEnabled: arenaLiveRequested
    }).init()
  : null;
const service = new MattMineService(database, {
  publicOrigin: process.env.MATT_MINE_PUBLIC_ORIGIN || null,
  adminKey: process.env.MATT_MINE_ADMIN_KEY || '',
  mainnetTransactionsEnabled,
  paymentVerifier,
  rewardManager,
  arenaService
});
const server = createMattMineHttpServer({ root, service });

server.listen(port, '0.0.0.0', () => {
  console.log(`MATT Mine v1.9 running at http://localhost:${port}`);
  console.log(`Ranked wallet network: ${service.config().chainName} (${service.config().chainId})`);
  console.log(`Mainnet transaction mode: ${mainnetTransactionsEnabled ? 'ENABLED (real RON)' : 'disabled'}`);
  console.log(`Reward publication: ${rewardManager.publicationEnabled ? 'PILOT ENABLED' : 'DRY RUN'}`);
  console.log(`Daily Arena: ${arenaEnabled ? `exact deployment pinned (${arenaContractAddress}); paid entry SECURITY-GATED pending input replay` : 'disabled until contract + receipt secret are configured'}`);
  console.log(`Server data: ${database.kind}${databaseUrl ? '' : ` (${dataFile})`}`);
});

let closing = false;
function closeServer() {
  if (closing) return;
  closing = true;
  server.close(async () => {
    await database.close();
    process.exit(0);
  });
}

process.once('SIGINT', closeServer);
process.once('SIGTERM', closeServer);
