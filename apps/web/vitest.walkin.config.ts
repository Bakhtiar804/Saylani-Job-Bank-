import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { parse } from 'dotenv';
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  'server-only': fileURLToPath(new URL('./src/test/server-only-stub.ts', import.meta.url)),
};

// Integration tests use the root .env, pointed at the isolated `jobbank_test` database.
const rootEnvPath = fileURLToPath(new URL('../../.env', import.meta.url));
const rootEnv = existsSync(rootEnvPath) ? parse(readFileSync(rootEnvPath)) : {};
const withDatabase = (url: string | undefined, name: string) => {
  if (!url) return '';
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
};
const testDb = process.env.TEST_DATABASE_NAME ?? 'jobbank_test';
if (
  !/^jobbank_test(?:_[a-z0-9_]+)?$/.test(testDb) ||
  [rootEnv.DATABASE_URL, rootEnv.DATABASE_MIGRATOR_URL].some(
    (url) => url && new URL(url).pathname === '/' + testDb,
  )
)
  throw new Error('Refusing to test against development data');
const testMigratorUrl = withDatabase(rootEnv.DATABASE_MIGRATOR_URL, testDb);
if (
  process.env.TEST_DATABASE_MIGRATOR_URL &&
  process.env.TEST_DATABASE_MIGRATOR_URL !== testMigratorUrl
)
  throw new Error('Test migrator does not match the isolated database');
// globalSetup runs in this (main) process, where `test.env` does not apply.
process.env.TEST_DATABASE_MIGRATOR_URL ??= testMigratorUrl;

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: 'unit',
          environment: 'node',
          include: ['src/**/*.test.ts'],
          exclude: ['src/**/*.integration.test.ts'],
          env: { SKIP_ENV_VALIDATION: '1', LOG_LEVEL: 'silent' },
        },
      },
      {
        plugins: [react()],
        resolve: { alias },
        test: {
          name: 'components',
          environment: 'jsdom',
          include: ['src/**/*.test.tsx'],
          setupFiles: ['./src/test/setup-dom.ts'],
          env: { SKIP_ENV_VALIDATION: '1', LOG_LEVEL: 'silent' },
        },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.integration.test.ts'],
          globalSetup: ['./src/test/integration-setup.ts'],
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 60_000,
          env: {
            ...rootEnv,
            NODE_ENV: 'test',
            LOG_LEVEL: 'silent',
            DATABASE_URL: withDatabase(rootEnv.DATABASE_URL, testDb),
            TEST_DATABASE_MIGRATOR_URL: testMigratorUrl,
            // Deterministic auth secret, and in-memory rate limits (no cross-run Redis state).
            BETTER_AUTH_SECRET: 'integration-test-secret-integration-test-secret',
            REDIS_URL: '',
            MAIL_TRANSPORT: 'memory',
          },
        },
      },
    ],
  },
});
