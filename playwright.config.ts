import { defineConfig } from '@playwright/test';

const common = [
  'OMNIFLOW_HOST=127.0.0.1',
  'OMNIFLOW_ENV=development',
  'OMNIFLOW_ADMIN_EMAIL=admin@example.com',
  'OMNIFLOW_ADMIN_PASSWORD=correct-horse-battery-staple',
  'OMNIFLOW_LOG_LEVEL=silent',
].join(' ');

/** Two throw-away servers: OmniFlow as shipped (18091) and in NEXORA mode with the fake Core (18092). */
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
      command: 'node --disable-warning=ExperimentalWarning scripts/serve-site.ts',
      url: 'http://127.0.0.1:18093/',
      reuseExistingServer: false,
      timeout: 15_000,
    },
    {
      command: `rm -rf .e2e-data/standalone && ${common} OMNIFLOW_DATA_DIR=.e2e-data/standalone OMNIFLOW_PORT=18091 OMNIFLOW_PUBLIC_URL=http://127.0.0.1:18091 node --disable-warning=ExperimentalWarning server/main.ts`,
      url: 'http://127.0.0.1:18091/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `rm -rf .e2e-data/nexora && ${common} OMNIFLOW_MODE=nexora OMNIFLOW_NEXORA_CORE=fake OMNIFLOW_DATA_DIR=.e2e-data/nexora OMNIFLOW_PORT=18092 OMNIFLOW_PUBLIC_URL=http://127.0.0.1:18092 node --disable-warning=ExperimentalWarning server/main.ts`,
      url: 'http://127.0.0.1:18092/healthz',
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
