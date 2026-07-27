import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const files = readdirSync(resolve('tests'))
  .filter((name) => name.endsWith('.test.mjs'))
  .sort();
let failed = 0;
let passed = 0;

for (const file of files) {
  const result = spawnSync(process.execPath, ['--test', resolve('tests', file)], {
    encoding: 'utf8',
    env: process.env
  });
  if (result.status === 0) {
    passed += 1;
    process.stdout.write('.');
    continue;
  }
  failed += 1;
  process.stdout.write(`\n\nFAILED: tests/${file}\n`);
  process.stdout.write(result.stdout || '');
  process.stderr.write(result.stderr || '');
}

process.stdout.write(`\n${passed} test files passed; ${failed} failed.\n`);
if (failed) process.exitCode = 1;
