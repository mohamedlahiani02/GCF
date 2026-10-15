import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Integration tests share one PostgreSQL database: run files one after another.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
