import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["tests/**/*.test.ts"],
          exclude: ["tests/e2e/**"],
        },
      },
      {
        test: {
          name: "e2e",
          include: ["tests/e2e/**/*.test.ts"],
          globalSetup: ["tests/e2e/global-setup.ts"],
          setupFiles: ["tests/e2e/setup.ts"],
          hookTimeout: 120_000,
          testTimeout: 30_000,
          // The e2e tests share a single database that is truncated between
          // tests, so files must not run in parallel against it.
          fileParallelism: false,
        },
      },
    ],
  },
})
