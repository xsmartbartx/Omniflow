import { defineConfig } from '@playwright/test';

const common = [
  'CONSTANS_HOST=127.0.0.1',
  'CONSTANS_ENV=development',
  'CONSTANS_ADMIN_EMAIL=admin@example.com',
  'CONSTANS_ADMIN_PASSWORD=correct-horse-battery-staple',
  'CONSTANS_LOG_LEVEL=silent',
].join(' ');

/** Two throw-away servers: Constans as shipped (18091) and in NEXORA mode with the fake Core (18092). */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    // The system Chrome, so no browser download is needed.
    channel: 'chrome',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: `rm -rf .e2e-data/standalone && ${common} CONSTANS_DATA_DIR=.e2e-data/standalone CONSTANS_PORT=18091 CONSTANS_PUBLIC_URL=http://127.0.0.1:18091 node --disable-warning=ExperimentalWarning server/main.ts`,
      url: 'http://127.0.0.1:18091/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `rm -rf .e2e-data/nexora && ${common} CONSTANS_MODE=nexora CONSTANS_NEXORA_CORE=fake CONSTANS_DATA_DIR=.e2e-data/nexora CONSTANS_PORT=18092 CONSTANS_PUBLIC_URL=http://127.0.0.1:18092 node --disable-warning=ExperimentalWarning server/main.ts`,
      url: 'http://127.0.0.1:18092/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
