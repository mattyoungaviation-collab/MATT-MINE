import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileDatabase, PostgresDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { RoninPaymentVerifier } from '../server/payment-verifier.js';
import { MattMineService } from '../server/service.js';

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
const service = new MattMineService(database, {
  publicOrigin: process.env.MATT_MINE_PUBLIC_ORIGIN || null,
  adminKey: process.env.MATT_MINE_ADMIN_KEY || '',
  mainnetTransactionsEnabled,
  paymentVerifier
});
const server = createMattMineHttpServer({ root, service });

server.listen(port, '0.0.0.0', () => {
  console.log(`MATT Mine v1.0 running at http://localhost:${port}`);
  console.log(`Ranked wallet network: ${service.config().chainName} (${service.config().chainId})`);
  console.log(`Mainnet transaction mode: ${mainnetTransactionsEnabled ? 'ENABLED (real RON)' : 'disabled'}`);
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
