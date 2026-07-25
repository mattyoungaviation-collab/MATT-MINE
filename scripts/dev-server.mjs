import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonFileDatabase } from '../server/database.js';
import { createMattMineHttpServer } from '../server/http.js';
import { MattMineService } from '../server/service.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.PORT || 4173);
const dataFile = resolve(root, process.env.MATT_MINE_DATA_FILE || 'data/matt-mine-store.json');
const database = await new JsonFileDatabase(dataFile).init();
const service = new MattMineService(database, {
  chainId: Number(process.env.MATT_MINE_CHAIN_ID || 202601),
  publicOrigin: process.env.MATT_MINE_PUBLIC_ORIGIN || null,
  adminKey: process.env.MATT_MINE_ADMIN_KEY || ''
});
const server = createMattMineHttpServer({ root, service });

server.listen(port, '0.0.0.0', () => {
  console.log(`MATT Mine v0.6 running at http://localhost:${port}`);
  console.log(`Ranked wallet network: ${service.config().chainName} (${service.config().chainId})`);
  console.log(`Server data: ${dataFile}`);
});

function closeServer() {
  server.close(() => process.exit(0));
}

process.once('SIGINT', closeServer);
process.once('SIGTERM', closeServer);
