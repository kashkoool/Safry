export interface AuthUser {
  isPlatformAdmin?: boolean;
  userId: string;
  tenantId: string;
  membershipId: string;
  providerOrganizationId?: string | null;
  sessionId?: string;
  email: string;
  roles: string[];
  permissions: string[];
}
