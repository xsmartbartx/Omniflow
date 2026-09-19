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
      ],
      exclude: ['**/*.d.ts', '**/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov'],
    },
  },
});
