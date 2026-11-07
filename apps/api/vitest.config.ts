import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one PostgreSQL database: run files one after another.
    fileParallelism: false,
    // Every file runs at the same fixed date, for the application and the database alike.
    setupFiles: ["./test/clock.ts"],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
