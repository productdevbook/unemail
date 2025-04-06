import tsconfigPaths from 'vite-tsconfig-paths'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    testTimeout: 30_000,
    reporters: process.env.GITHUB_ACTIONS ? ['dot', 'github-actions'] : ['dot'],
    coverage: {
      reporter: ['text', 'clover', 'json'],
      include: ['src/**/*.ts'],
    },
    include: ['test/**/*.test.ts'],
  },
})
