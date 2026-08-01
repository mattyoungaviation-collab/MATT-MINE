import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const bad = [];
for await (const file of glob(['server/**/*.js','src/**/*.js','scripts/**/*.mjs','tests/**/*.mjs'])) {
  const source = await readFile(file, 'utf8');
  if (/\r(?!\n)/.test(source) || /[ \t]+$/m.test(source) || (!source.endsWith('\n') && source.length)) bad.push(file);
}
if (bad.length) {
  console.error(`Formatting hygiene failed:\n${bad.join('\n')}`);
  process.exitCode = 1;
}
