export interface AuthUser {
  isPlatformAdmin?: boolean;
  /** True when the account has completed second-factor enrolment (read per request, never from the token). */
  mfaEnabled?: boolean;
  userId: string;
  tenantId: string;
  membershipId: string;
  providerOrganizationId?: string | null;
  sessionId?: string;
  email: string;
  roles: string[];
  permissions: string[];
}
