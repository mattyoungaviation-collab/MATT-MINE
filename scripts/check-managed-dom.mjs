import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

const reviewedLegacyLimits = new Map(Object.entries({
  'src/admin.js': 33,
  'src/adminCompetitionStudio.js': 9,
  'src/adminEconomy.js': 4,
  'src/adminPlayerEditor.js': 3,
  'src/main.js': 40,
  'src/nuggetShop.js': 8,
  'src/practiceClaimFlow.js': 1,
  'src/game/mineHub.js': 7,
  'src/game/mineLoadingScreen.js': 1
}));
const violations = [];
for await (const file of glob(['src/**/*.js'])) {
  const normalizedFile = file.replaceAll('\\', '/');
  const source = await readFile(file, 'utf8');
  let legacyCount = 0;
  source.split(/\r?\n/).forEach((line, index) => {
    if (/\.innerHTML\s*=/.test(line) && !line.includes('dom-security-reviewed')) {
      legacyCount += 1;
      if (!reviewedLegacyLimits.has(normalizedFile)) violations.push(`${normalizedFile}:${index + 1}: unmanaged innerHTML assignment`);
    }
  });
  if (legacyCount > (reviewedLegacyLimits.get(normalizedFile) || 0)) {
    violations.push(`${normalizedFile}: innerHTML count ${legacyCount} exceeds reviewed migration baseline ${reviewedLegacyLimits.get(normalizedFile) || 0}`);
  }
  if (/mattMineAdminKey|x-matt-admin-key/.test(source)) violations.push(`${normalizedFile}: browser Admin secret transport is forbidden`);
}
if (violations.length) {
  console.error(violations.join('\n'));
  console.error('Use DOM creation/textContent or add a narrowly reviewed safe-template boundary.');
  process.exitCode = 1;
}
