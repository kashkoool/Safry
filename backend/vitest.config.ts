import { configDefaults, defineConfig } from "vitest/config";

// Unit tests: pure logic, no database. Integration specs live in test/ and use vitest.int.config.ts.
export default defineConfig({
  test: { exclude: [...configDefaults.exclude, "test/**", "dist/**"] }
});
