// Isolated UI verification server. Never migrates, seeds or connects to development data.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { readFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
const web = resolve(__dirname, '../apps/web');
const req = createRequire(resolve(web, 'package.json'));
const { parse } = req('dotenv');
const configured = parse(readFileSync(resolve(__dirname, '../.env')));
const testUrl = new URL(configured.DATABASE_URL);
const testDatabase = process.env.TEST_DATABASE_NAME ?? 'jobbank_test';
if (!/^jobbank_test(?:_[a-z0-9_]+)?$/.test(testDatabase) || testUrl.pathname === '/' + testDatabase)
  throw Error('Expected a separately named isolated test database');
testUrl.pathname = '/' + testDatabase;
const child = spawn(
  process.execPath,
  [req.resolve('next/dist/bin/next'), 'dev', '--turbopack', '-p', '3104'],
  {
    cwd: web,
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ...configured,
      DATABASE_URL: testUrl.toString(),
      DATABASE_MIGRATOR_URL: '',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3104',
      NEXT_DIST_DIR: '.next-walkin-ui',
      BETTER_AUTH_SECRET: 'integration-test-secret-integration-test-secret',
      REDIS_URL: '',
      MAIL_TRANSPORT: 'memory',
    },
  },
);
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill());
child.on('exit', (code) => process.exit(code ?? 0));
