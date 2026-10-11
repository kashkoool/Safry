import type { Prisma, PrismaClient } from "../src/generated/prisma/client.js";
import { PERMISSIONS, ROLE_PERMISSIONS, SYSTEM_ROLES } from "../src/modules/identity/access/system-roles.js";
import { withRlsBypass } from "./rls-bypass.js";

export interface BootstrapInput {
  tenantCode: string;
  tenantName: string;
  adminEmail: string;
  adminPasswordHash: string;
}

export interface BootstrapOptions {
  /**
   * Explicit opt-in: let an EXISTING ordinary (non platform-admin) account become the tenant administrator. Without it such a
   * pre-existing account is refused, because anyone can register an address before the operator bootstraps it.
   */
  adoptExistingAccount?: boolean;
}

export interface BootstrapResult {
  tenant: { id: string };
  roles: Map<string, { id: string }>;
  adminMembershipId: string;
  tenantCreated: boolean;
  userCreated: boolean;
  adminMembershipCreated: boolean;
}

/**
 * The real, non-demo start of a deployment: first tenant, permission catalogue, system roles and one
 * platform/tenant administrator. Idempotent and CREATE-ONLY for anything an operator may have changed: re-running never
 * re-activates a suspended administrator, resets a password, renames a role, or re-grants a role or a role permission
 * an operator removed. Runs in one transaction with the RLS bypass flag set, so it
 * works for a non-superuser, non-BYPASSRLS owner login.
 */
export async function bootstrapCore(prisma: PrismaClient, input: BootstrapInput, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  return withRlsBypass(prisma, (tx) => bootstrapInTransaction(tx, input, options));
}

async function bootstrapInTransaction(tx: Prisma.TransactionClient, input: BootstrapInput, options: BootstrapOptions): Promise<BootstrapResult> {
  const existingUser = await tx.user.findUnique({ where: { emailNormalized: input.adminEmail } });
  if (existingUser) {
    if (existingUser.status !== "ACTIVE" || existingUser.deletedAt !== null)
      throw new Error("BOOTSTRAP_ADMIN_EMAIL belongs to an account that is not active; use a new address or reactivate it first");
    if (!existingUser.isPlatformAdmin && !options.adoptExistingAccount)
      throw new Error(
        "BOOTSTRAP_ADMIN_EMAIL belongs to an ordinary account (not a platform administrator); use a new address, or pass BOOTSTRAP_ADOPT_EXISTING_ACCOUNT=true if you have verified that this person owns it"
      );
  }

  const existingTenant = await tx.tenant.findUnique({ where: { code: input.tenantCode } });
  const tenant = existingTenant ?? (await tx.tenant.create({ data: { code: input.tenantCode, name: input.tenantName } }));

  const permissionRecords = [];
  for (const [code, description] of PERMISSIONS)
    permissionRecords.push(await tx.permission.upsert({ where: { code }, update: { description }, create: { code, description } }));

  const roles = new Map<string, { id: string }>();
  for (const [code, name] of SYSTEM_ROLES) {
    const found = await tx.role.findUnique({ where: { tenantId_code: { tenantId: tenant.id, code } } });
    const role = found ?? (await tx.role.create({ data: { tenantId: tenant.id, code, name, isSystem: true } }));
    roles.set(code, role);
    if (found) continue; // existing role: its name and permissions belong to the operator now
    const allowed = new Set<string>(ROLE_PERMISSIONS[code]);
    await tx.rolePermission.createMany({
      data: permissionRecords.filter((p) => allowed.has(p.code)).map((p) => ({ roleId: role.id, permissionId: p.id })),
      skipDuplicates: true
    });
  }

  const user =
    existingUser ??
    (await tx.user.create({
      data: {
        email: input.adminEmail,
        emailNormalized: input.adminEmail,
        displayName: "Platform Administrator",
        isPlatformAdmin: true,
        passwordHash: input.adminPasswordHash,
        emailVerifiedAt: new Date()
      }
    }));

  const foundMembership = await tx.tenantMembership.findUnique({ where: { tenantId_userId: { tenantId: tenant.id, userId: user.id } } });
  const membership = foundMembership ?? (await tx.tenantMembership.create({ data: { tenantId: tenant.id, userId: user.id, status: "ACTIVE" } }));
  const adminRole = roles.get("tenant-admin");
  if (!adminRole) throw new Error("system role tenant-admin is missing");
  if (!foundMembership)
    await tx.membershipRole.create({ data: { membershipId: membership.id, roleId: adminRole.id, tenantId: tenant.id } });
  return {
    tenant,
    roles,
    adminMembershipId: membership.id,
    tenantCreated: !existingTenant,
    userCreated: !existingUser,
    adminMembershipCreated: !foundMembership
  };
}
