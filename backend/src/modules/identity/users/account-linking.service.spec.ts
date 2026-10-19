import { describe, expect, it } from "vitest";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AccountLinkingService } from "./account-linking.service.js";

/** Which accounts start verified: tenant-created ones yes, self-registered ones no. */
function fakeTx(): { tx: Prisma.TransactionClient; created: Array<Record<string, unknown>>; flag: string[] } {
  const created: Array<Record<string, unknown>> = [];
  const flag: string[] = [];
  const tx = {
    // Tagged-template raw queries: the identity flag read (previous value) and its set/reset.
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join("").includes("set_config")) flag.push(typeof values[0] === "string" ? values[0] : "on");
      return Promise.resolve([{ value: "off" }]);
    },
    user: {
      findUnique: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "u1", ...data });
      }
    }
  } as unknown as Prisma.TransactionClient;
  return { tx, created, flag };
}

describe("account creation and e-mail verification", () => {
  const input = { email: "New.Person@Example.test", displayName: "New", password: "unit test only password" };
  const service = new AccountLinkingService({} as never);

  it("self-registration creates an unverified account", async () => {
    const { tx, created } = fakeTx();
    await service.resolve(tx, "t1", input);
    expect(created[0]).toMatchObject({ emailNormalized: "new.person@example.test" });
    expect(created[0]).not.toHaveProperty("emailVerifiedAt");
  });

  it("a tenant-created account (invite path) is verified from the start", async () => {
    const { tx, created } = fakeTx();
    const result = await service.createOrInvite(tx, "t1", input);
    expect(result.awaitingOwnerConsent).toBe(false);
    expect(created[0]!["emailVerifiedAt"]).toBeInstanceOf(Date);
  });

  it("an explicit emailVerified flag (platform administrators creating a member) is honoured", async () => {
    const { tx, created } = fakeTx();
    await service.resolve(tx, "t1", { ...input, emailVerified: true });
    expect(created[0]!["emailVerifiedAt"]).toBeInstanceOf(Date);
  });
});

describe("identity lookup under row-level security on users", () => {
  it("raises the narrow identity flag around the lookup and the insert, and restores it", async () => {
    const { tx, flag } = fakeTx();
    await new AccountLinkingService({} as never).createOrInvite(tx, "t1", { email: "a@example.test", displayName: "A", password: "unit test only password" });
    expect(flag).toEqual(["on", "off", "on", "off"]);
  });
});
