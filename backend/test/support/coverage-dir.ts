import { join } from "node:path";

/** Where every spec records the requests it makes; test/support/route-coverage.ts reads them back. */
export const COVERAGE_DIR = join(import.meta.dirname, "..", ".coverage");
