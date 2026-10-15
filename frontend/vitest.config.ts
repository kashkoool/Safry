import { defineConfig } from "vitest/config";

// Unit tests cover pure, non-React modules only (run in plain Node). Playwright specs under e2e/ are not Vitest tests (unit specs use the .spec.ts suffix under src/, which the i18n scanner skips).
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.spec.ts"]
  }
});
