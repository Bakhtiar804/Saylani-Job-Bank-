import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  testMatch: 'walkin.spec.ts',
  workers: 1,
  timeout: 600000,
  expect: { timeout: 120000 },
  reporter: 'list',
  outputDir: './reports/walkin-ui',
  use: {
    channel: 'chrome',
    actionTimeout: 120000,
    baseURL: 'http://localhost:3104',
    viewport: { width: 1280, height: 900 },
    screenshot: 'only-on-failure',
    navigationTimeout: 120000,
  },
  webServer: {
    command: 'node tests/walkin-server.cjs',
    cwd: '..',
    url: 'http://localhost:3104/login',
    timeout: 180000,
    reuseExistingServer: process.env.WALKIN_REUSE_SERVER === '1',
  },
});
