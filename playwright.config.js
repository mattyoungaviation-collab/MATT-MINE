import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  globalSetup: './tests/browser/global-setup.mjs',
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'retain-on-failure' }
});
