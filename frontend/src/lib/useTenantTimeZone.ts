import { useEffect, useState } from "react";
import { useAuth } from "../auth/auth-context";
import { tenantAdmin } from "./tenant-admin";
import { validTimeZone } from "./tenant-settings";

/** The workspace's configured IANA time zone (undefined until loaded, when unset or when the user cannot read the tenant). */
export function useTenantTimeZone(): string | undefined {
  const { user } = useAuth();
  const allowed = Boolean(user?.permissions.includes("tenant.read"));
  const [zone, setZone] = useState<string | undefined>();
  useEffect(() => {
    if (!allowed) return;
    let live = true;
    tenantAdmin.tenant().then((tenant) => { if (live) setZone(validTimeZone(tenant.settings)); }).catch(() => undefined);
    return () => { live = false; };
  }, [allowed]);
  return zone;
}
