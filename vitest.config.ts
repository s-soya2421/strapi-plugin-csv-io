import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['server/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['server/src/**/*.ts'],
      exclude: ['server/src/**/*.test.ts', 'server/src/interfaces/**'],
    },
  },
});
