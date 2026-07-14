import { defineConfig } from "vitest/config";

// Integration tests live in tests/ (outside src/) so `pnpm build` never
// compiles them into dist. They need a real PostgreSQL: set DATABASE_URL to
// a MIGRATED, DISPOSABLE database before running - without it every DB
// suite skips itself (see tests/*.test.ts and docs/testing.md). Mirrors
// apps/bot/vitest.config.ts.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Suites share the one test database - files must not run concurrently.
    fileParallelism: false,
  },
});
