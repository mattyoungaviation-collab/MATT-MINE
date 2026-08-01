import { mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const connectionString = process.env.DATABASE_URL?.trim();
const encryptionRecipient = process.env.MATT_MINE_BACKUP_AGE_RECIPIENT?.trim();
if (!connectionString || !encryptionRecipient) {
  throw new Error('DATABASE_URL and MATT_MINE_BACKUP_AGE_RECIPIENT are required. Unencrypted backups are refused.');
}
const destination = resolve(process.env.MATT_MINE_BACKUP_DIRECTORY || 'backups');
await mkdir(destination, { recursive: true });
const timestamp = new Date().toISOString().replaceAll(':', '-');
const output = resolve(destination, `matt-mine-${timestamp}.dump.age`);
const dump = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', connectionString], { stdio: ['ignore', 'pipe', 'inherit'] });
const encrypt = spawn('age', ['--recipient', encryptionRecipient, '--output', output], { stdio: ['pipe', 'inherit', 'inherit'] });
dump.stdout.pipe(encrypt.stdin);
const [dumpCode, encryptCode] = await Promise.all([exitCode(dump), exitCode(encrypt)]);
if (dumpCode || encryptCode) throw new Error(`Encrypted backup failed (pg_dump=${dumpCode}, age=${encryptCode}).`);
console.log(JSON.stringify({ ok: true, output, encrypted: true }));

function exitCode(child) {
  return new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('close', resolveCode);
  });
}
