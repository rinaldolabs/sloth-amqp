import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Unit tests only by default. Integration tests live under test/integration/
    // and have their own runner (see vitest.integration.config.ts).
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'json', 'html'],
      reportOnFailure: true,
      exclude: ['src/index.ts', 'src/__tests__/**'],
      thresholds: {
        statements: 100,
        branches: 100,
        functions: 100,
        lines: 100,
        perFile: true,
      },
    },
  },
});
