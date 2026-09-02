import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["node_modules/**", "dist/**"],
    benchmark: {
      include: ["bench/**/*.bench.ts"],
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // types.ts compiles to nothing, so it has no lines to cover.
      exclude: ["src/core/types.ts"],
      reporter: ["text"],
      // Set at what the suite measures today, rounded down. A floor, not an
      // aspiration: raised whenever coverage rises, never lowered to fit.
      thresholds: { statements: 91, branches: 84, functions: 90, lines: 93 },
    },
  },
})
