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
      // Set at where the suite measured on the day it was added, rounded
      // down. A floor, not an aspiration: it can only be raised.
      thresholds: { statements: 82, branches: 74, functions: 81, lines: 85 },
    },
  },
})
