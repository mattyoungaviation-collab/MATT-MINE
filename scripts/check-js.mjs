import { spawn } from 'node:child_process';
import { glob } from 'node:fs/promises';

const files = [];
for await (const file of glob(['server/**/*.js','src/**/*.js','scripts/**/*.mjs','tests/**/*.mjs'])) files.push(file);
for (const file of files) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code) process.exit(code);
}
