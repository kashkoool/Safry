import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { World } from "./support/world.js";

/** a runaway query is cancelled by the database and the pool stays usable. */
describe("database statement timeout", () => {
  let world: World;
  beforeAll(async () => {
    world = await World.start({ DATABASE_STATEMENT_TIMEOUT_MS: "300" });
  });
  afterAll(async () => {
    await world.stop();
  });

  it("cancels a query that runs longer than DATABASE_STATEMENT_TIMEOUT_MS, then keeps serving", async () => {
    const { PrismaService } = await import("../dist/database/prisma.service.js");
    const prisma = world.app.get(PrismaService);
    const started = Date.now();
    await expect(prisma.$queryRaw`SELECT pg_sleep(5)`).rejects.toThrow(/statement timeout|canceling statement|57014/i);
    expect(Date.now() - started).toBeLessThan(3000);
    const rows = await prisma.$queryRaw<Array<{ ok: number }>>`SELECT 1 AS ok`;
    expect(rows[0]?.ok).toBe(1);
  });
});
