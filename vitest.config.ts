import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 20_000,
    pool: 'forks',
    coverage: {
      provider: 'v8',
      include: [
        'core/**',
        'security/**',
        'capabilities/**',
        'state/**',
        'orchestration/**',
        'insight/**',
        'authoring/**',
        'gateway/**',
        'cli/**',
        'server/**',
      ],
      exclude: ['**/*.d.ts', '**/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
      // The floor CI enforces (npm run test:coverage). The components the whole design leans on must
      // stay above 90%; everything else above 80%.
      thresholds: {
        statements: 88,
        lines: 90,
        functions: 90,
        branches: 78,
        'core/**': { statements: 90, lines: 90, functions: 90, branches: 80 },
        'orchestration/compiler/**': { statements: 90, lines: 90, functions: 90, branches: 85 },
        'orchestration/orchestrator/**': { statements: 90, lines: 90, functions: 90, branches: 80 },
        'security/policy/**': { statements: 90, lines: 90, functions: 90, branches: 85 },
        'security/secret-broker/**': { statements: 95, lines: 95, functions: 95, branches: 90 },
      },
    },
  },
});
