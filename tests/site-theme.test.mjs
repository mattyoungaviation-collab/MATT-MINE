import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  SITE_THEME_CONTROLS,
  SITE_THEME_GROUPS,
  SITE_THEME_PRESETS,
  applySiteTheme,
  changedSiteThemeControls,
  defaultSiteTheme,
  isSiteThemePreview,
  normalizeSiteTheme,
  siteThemePreset,
  themeCssText,
  validateSiteTheme
} from '../src/game/siteTheme.js';
import { MemoryDatabase } from '../server/database.js';
import { MattMineService } from '../server/service.js';
import { normalizeServerState } from '../server/state.js';
import { buildAdminControlIndex, searchAdminControls } from '../src/adminControlRegistry.js';

const NOW = Date.UTC(2026, 8, 1, 17, 0, 0);

test('Theme Studio exposes a complete bounded visual system and curated presets', () => {
  assert.equal(SITE_THEME_GROUPS.length, 8);
  assert.ok(SITE_THEME_CONTROLS.length >= 80);
  assert.ok(SITE_THEME_PRESETS.length >= 6);
  const ids = new Set(SITE_THEME_CONTROLS.map((control) => control.id));
  assert.equal(ids.size, SITE_THEME_CONTROLS.length);
  for (const control of SITE_THEME_CONTROLS) {
    assert.ok(SITE_THEME_GROUPS.some((group) => group.id === control.group), `${control.id} has a known group`);
    assert.notEqual(control.default, undefined, `${control.id} has a default`);
  }
  const ronin = siteThemePreset('ronin');
  assert.equal(ronin.name, 'Ronin Reactor');
  assert.equal(ronin.tokens.primaryButtonStyle, 'cyan');
  assert.equal(changedSiteThemeControls(ronin, defaultSiteTheme()).length > 5, true);
  const index = buildAdminControlIndex();
  assert.equal(index.filter((entry) => entry.id.startsWith('theme:')).length, SITE_THEME_CONTROLS.length + 3);
  assert.equal(searchAdminControls(index, 'theme glow intensity')[0].id, 'theme:glowIntensity');
  assert.equal(isSiteThemePreview('?theme-preview=1&theme-preview-embed=1'), true);
});

test('Theme Studio previews the real site, synchronizes drafts, and hides preview chrome normally', async () => {
  const [admin, main, css] = await Promise.all([
    readFile(new URL('../admin.html', import.meta.url), 'utf8'),
    readFile(new URL('../src/main.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/site-theme.css', import.meta.url), 'utf8')
  ]);
  assert.match(admin, /<iframe[^>]+id="theme-preview-site"[^>]+theme-preview-embed=1/);
  assert.match(main, /addEventListener\('storage'/);
  assert.match(main, /mattmine:theme-preview/);
  assert.match(main, /event\.origin !== location\.origin/);
  assert.match(css, /\.theme-preview-banner\[hidden\]\s*\{\s*display:\s*none !important;/);
});

test('theme normalization repairs stored corruption while strict imports reject unsafe controls', () => {
  const normalized = normalizeSiteTheme({
    name: '  Custom Theme  ',
    tokens: {
      brandGold: '#ABCDEF',
      baseFontSize: 999,
      displayFont: 'untrusted-font-stack',
      reducedMotion: true
    }
  });
  assert.equal(normalized.name, 'Custom Theme');
  assert.equal(normalized.tokens.brandGold, '#abcdef');
  assert.equal(normalized.tokens.baseFontSize, 22);
  assert.equal(normalized.tokens.displayFont, 'industrial');
  assert.equal(normalized.tokens.reducedMotion, true);
  assert.throws(
    () => validateSiteTheme({ name: 'Unsafe', tokens: { arbitraryCss: 'body { display:none }' } }),
    /Unknown theme controls/
  );
  assert.throws(
    () => validateSiteTheme({ name: 'Unsafe', tokens: { brandGold: 'url(javascript:alert(1))' } }),
    /six-digit hex color/
  );
});

test('theme application only writes allowlisted variables and component attributes', () => {
  const properties = new Map();
  const fakeRoot = {
    style: { setProperty(name, value) { properties.set(name, value); } },
    dataset: {}
  };
  const theme = siteThemePreset('terminal');
  applySiteTheme(theme, fakeRoot);
  assert.equal(properties.get('--mm-gold'), theme.tokens.brandGold);
  assert.equal(properties.get('--mm-font-display').includes('Arial Narrow'), true);
  assert.equal(fakeRoot.dataset.mmPrimaryButton, 'outline');
  assert.equal(fakeRoot.dataset.mmTheme, 'Deep Terminal');
  assert.match(themeCssText(theme), /--mm-gold: #78f29b;/);
  assert.doesNotMatch(themeCssText(theme), /arbitraryCss/);
});

test('server state migration and audited publishing preserve the live theme', async () => {
  const migrated = normalizeServerState({ version: 19 });
  assert.equal(migrated.siteTheme.version, 1);
  assert.equal(migrated.siteTheme.published.name, 'MATT Mine Original');

  const database = new MemoryDatabase(migrated);
  const service = new MattMineService(database, {
    now: () => NOW,
    publicOrigin: 'http://localhost:4173',
    adminKey: 'admin-secret'
  });
  const before = await service.publicSiteTheme();
  assert.equal(before.version, 1);

  const theme = siteThemePreset('crystal');
  const result = await service.updateAdminSiteTheme('admin-secret', { theme }, 'Seasonal crystal launch');
  assert.equal(result.siteTheme.version, 2);
  assert.equal(result.siteTheme.published.name, 'Crystal Vault');

  const publicTheme = await service.publicSiteTheme();
  assert.equal(publicTheme.version, 2);
  assert.equal(publicTheme.theme.tokens.brandCyan, '#9a6cff');
  const state = await database.read();
  assert.equal(state.audit.at(-1).action, 'SITE_THEME_PUBLISHED');
  assert.match(state.audit.at(-1).details, /Seasonal crystal launch/);

  await assert.rejects(
    () => service.updateAdminSiteTheme('admin-secret', { theme: { name: 'Broken', tokens: { bodyFont: 'remote-url' } } }, 'Invalid import test'),
    (error) => error.code === 'site_theme_invalid'
  );
});
