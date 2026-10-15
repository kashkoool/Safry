import { defineConfig } from "vitest/config";

// Unit tests cover pure, non-React modules only (run in plain Node). Playwright specs under e2e/ are not Vitest tests.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"]
  }
});
