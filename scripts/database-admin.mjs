import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { PostgresDatabase } from '../server/database.js';

const command = process.argv[2] || '';
const apply = process.argv.includes('--apply');
const dryRun = process.argv.includes('--dry-run');

if (command === 'migrate' && dryRun) {
  const migrationRoot = resolve('migrations');
  const files = (await readdir(migrationRoot)).filter((name) => /^\d+_[a-z0-9_]+\.up\.sql$/.test(name)).sort();
  const migrations = [];
  for (const file of files) {
    const sql = await readFile(resolve(migrationRoot, file), 'utf8');
    migrations.push({ file, checksum: createHash('sha256').update(sql).digest('hex'), bytes: Buffer.byteLength(sql) });
  }
  console.log(JSON.stringify({ ok: true, dryRun: true, migrations, effect: 'No database connection or mutation.' }, null, 2));
  process.exit(0);
}
if (command === 'rollback' && !apply) {
  const sql = await readFile(resolve('migrations/rollback/001_disable_normalized_cutover.sql'), 'utf8');
  console.log(JSON.stringify({ ok: true, dryRun: true, effect: 'Return reads to legacy and disable dual writes; no table or financial record is deleted.', sql }, null, 2));
  process.exit(0);
}

const connectionString = process.env.DATABASE_URL?.trim();
if (!connectionString) throw new Error('DATABASE_URL is required. This command never guesses a database target.');
const database = await new PostgresDatabase(connectionString, {
  ssl: process.env.MATT_MINE_DATABASE_SSL === 'true',
  rejectUnauthorized: process.env.MATT_MINE_DATABASE_SSL_REJECT_UNAUTHORIZED === 'true',
  maxConnections: 2
}).init();

try {
  if (command === 'migrate') {
    console.log(JSON.stringify({ ok: true, command, note: 'Versioned migrations applied; legacy state retained.' }));
  } else if (command === 'backfill') {
    console.log(JSON.stringify(await database.backfillNormalized(), null, 2));
  } else if (command === 'validate') {
    const result = await database.validateNormalized();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 2;
  } else if (command === 'reconcile') {
    const result = await database.query(`
      SELECT idempotency_key,address,purpose,quote_id,transaction_hash,state,error_code,created_at_ms,updated_at_ms
      FROM matt_mine_normalized.payment_operations
      WHERE state <> 'completed'
      ORDER BY updated_at_ms ASC
      LIMIT 1000`);
    console.log(JSON.stringify({ ok: true, count: result.rowCount, operations: result.rows }, null, 2));
  } else if (command === 'rollback') {
    const sql = await readFile(resolve('migrations/rollback/001_disable_normalized_cutover.sql'), 'utf8');
    await database.query(sql);
    console.log(JSON.stringify({ ok: true, applied: true, financialHistoryDeleted: false }));
  } else {
    throw new Error('Usage: database-admin.mjs migrate|backfill|validate|reconcile|rollback [--dry-run|--apply]');
  }
} finally {
  await database.close();
}
