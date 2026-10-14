import { describe, expect, it } from "vitest";
import type { Prisma } from "../../../generated/prisma/client.js";
import { AccountLinkingService } from "./account-linking.service.js";

/** Which accounts start verified: tenant-created ones yes, self-registered ones no. */
function fakeTx(): { tx: Prisma.TransactionClient; created: Array<Record<string, unknown>> } {
  const created: Array<Record<string, unknown>> = [];
  const tx = {
    user: {
      findUnique: () => Promise.resolve(null),
      create: ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: "u1", ...data });
      }
    }
  } as unknown as Prisma.TransactionClient;
  return { tx, created };
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
