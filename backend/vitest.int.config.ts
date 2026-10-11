import { defineConfig } from "vitest/config";

// Integration tests: the compiled app (dist/) runs against a real embedded PostgreSQL started in
// global setup, with every migration applied and row-level security forced on.
export default defineConfig({
  test: {
    include: ["test/**/*.int.spec.ts"],
    globalSetup: ["test/support/global-setup.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 180_000
  }
});
