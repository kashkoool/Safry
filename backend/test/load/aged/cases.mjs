// The endpoint cases of the sweep: every route of the API (76), as the right actor, with a realistic payload.
// Each case: { route, name, actor, n, prep?, req, expect, tag? }.  prep runs untimed and may return a value passed to req.
import { call, nextIp, sleep } from "./common.mjs";
import { latestLink, tokenOf } from "./world.mjs";

const stamp = Math.random().toString(36).slice(2, 8);
const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const PUB = { anon: true };

export function buildCases(w, st) {
  const A = w.actors;
  const base = w.run.base;
  const cases = [];
  const add = (c) => cases.push({ n: 200, expect: [200], ...c });

  const createPending = async (i, dayOffset = 10 + (i % 300)) => {
    const s = await w.actor("traveler", i);
    const serviceId = st.bookableServices[i % st.bookableServices.length];
    const r = await call(base, "POST", "/bookings", { token: s.token, body: { serviceId, travelersCount: 2, serviceDate: days(dayOffset + (i % 5)) } });
    if (r.status !== 201 && r.status !== 200) throw new Error(`createPending ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    return { id: r.body.id, session: s };
  };
  const cancel = async (b) => { await call(base, "PATCH", `/bookings/${b.id}/status`, { token: b.session.token, body: { status: "CANCELLED" } }); };

  // ---------------------------------------------------------------- health and metrics (anonymous / scraper)
  add({ route: "GET /health/live", name: "health live", ...PUB, req: () => ({ method: "GET", path: "/health/live" }) });
  add({ route: "GET /health/ready", name: "health ready", ...PUB, req: () => ({ method: "GET", path: "/health/ready" }) });
  add({ route: "GET /metrics", name: "metrics scrape", ...PUB, req: () => ({ method: "GET", path: "/metrics", headers: { authorization: `Bearer ${w.run.METRICS_TOKEN}` } }) });

  // ---------------------------------------------------------------- authentication
  add({ route: "POST /auth/register/customer", name: "register customer", ...PUB, expect: [200, 201, 202], req: (i) => ({ method: "POST", path: "/auth/register/customer", body: { displayName: `Sweep Customer ${i}`, email: `sweep-c-${stamp}-${i}@example.test`, password: `Sweep-${stamp}-pw-${i}-x`, tenantCode: A.tenantCode } }) });
  add({ route: "POST /auth/register/provider", name: "register provider", ...PUB, expect: [200, 201, 202], req: (i) => ({ method: "POST", path: "/auth/register/provider", body: { displayName: `Sweep Provider ${i}`, email: `sweep-p-${stamp}-${i}@example.test`, password: `Sweep-${stamp}-pw-${i}-x`, tenantCode: A.tenantCode, organizationName: `Sweep Org ${stamp} ${i}`, organizationNameEn: `Sweep Org ${stamp} ${i}`, type: "TRAVEL_COMPANY", city: "Riyadh", phone: "", licenseNumber: `L-${stamp}-${i}` } }) });
  add({ route: "POST /auth/login", name: "login ok (traveler)", ...PUB, req: (i) => ({ method: "POST", path: "/auth/login", body: { email: A.travelers[i % 36].email, password: A.password, tenantCode: A.tenantCode } }) });
  add({ route: "POST /auth/login", name: "login wrong password, unknown e-mail", ...PUB, expect: [401], req: (i) => ({ method: "POST", path: "/auth/login", body: { email: `nobody-${stamp}-${i}@example.test`, password: "wrong-password-123", tenantCode: A.tenantCode } }) });
  add({ route: "POST /auth/login", name: "login wrong password, known e-mail", ...PUB, expect: [401, 429], req: (i) => ({ method: "POST", path: "/auth/login", body: { email: A.travelers[(i % 30) + 4].email, password: "wrong-password-123", tenantCode: A.tenantCode } }) });
  add({ route: "POST /auth/mfa/verify", name: "mfa verify (platform admin)", ...PUB, prep: async () => { const r = await w.login(A.platform.email, A.platform.tenantCode); await w.resetMfaStep(A.platform.email); return { mfaToken: r.body.mfaToken, code: w.totp() }; }, req: (i, p) => ({ method: "POST", path: "/auth/mfa/verify", body: p }) });
  {
    const chain = { token: null };
    add({ route: "POST /auth/refresh", name: "refresh token rotation", ...PUB,
      prep: async () => { if (!chain.token) { const r = await w.login(A.travelers[35].email, A.tenantCode); chain.token = r.body.refreshToken; } return chain.token; },
      req: (i, p) => ({ method: "POST", path: "/auth/refresh", body: { refreshToken: p } }),
      after: (r) => { if (r.status === 200) chain.token = r.body.refreshToken; } });
  }
  add({ route: "POST /auth/logout", name: "logout", ...PUB, expect: [204], prep: async (i) => { const r = await w.login(A.travelers[32 + (i % 4)].email, A.tenantCode); return r.body.refreshToken; }, req: (i, p) => ({ method: "POST", path: "/auth/logout", body: { refreshToken: p } }) });
  add({ route: "POST /auth/logout-all", name: "logout everywhere", n: 200, expect: [204], prep: async (i) => { const r = await w.login(A.travelers[36 + (i % 2)].email, A.tenantCode); return r.body.accessToken; }, req: (i, p) => ({ method: "POST", path: "/auth/logout-all", token: p }) });
  add({ route: "GET /auth/me", name: "auth me", actor: "traveler", req: () => ({ method: "GET", path: "/auth/me" }) });
  add({ route: "GET /auth/sessions", name: "list own sessions (heavy history user)", actor: "traveler", req: () => ({ method: "GET", path: "/auth/sessions" }) });
  add({ route: "DELETE /auth/sessions/:id", name: "end one other session", expect: [204], prep: async (i) => { const keep = await w.login(A.travelers[38].email, A.tenantCode); await w.login(A.travelers[38].email, A.tenantCode); const list = await call(base, "GET", "/auth/sessions", { token: keep.body.accessToken }); return { token: keep.body.accessToken, sid: list.body[0].id }; }, req: (i, p) => ({ method: "DELETE", path: `/auth/sessions/${p.sid}`, token: p.token }) });
  add({ route: "POST /auth/activity", name: "activity ping", actor: "traveler", expect: [204], req: () => ({ method: "POST", path: "/auth/activity" }) });
  {
    const pw = { cur: A.password, alt: `Alt-${stamp}-pw-changed-1x` };
    add({ route: "POST /auth/password", name: "change password", expect: [204],
      prep: async () => { const r = await w.login(A.travelers[39].email, A.tenantCode, pw.cur); if (r.status !== 200) throw new Error(`pw login ${r.status}`); return r.body.accessToken; },
      req: (i, p) => ({ method: "POST", path: "/auth/password", token: p, body: { currentPassword: pw.cur, newPassword: pw.alt } }),
      after: (r) => { if (r.status === 204) [pw.cur, pw.alt] = [pw.alt, pw.cur]; } });
  }
  add({ route: "POST /auth/password/forgot", name: "forgot password", ...PUB, expect: [202], req: (i) => ({ method: "POST", path: "/auth/password/forgot", body: { email: A.travelers[i % 30].email } }) });
  add({ route: "POST /auth/password/reset", name: "reset password, invalid token", ...PUB, expect: [400], req: (i) => ({ method: "POST", path: "/auth/password/reset", body: { token: "A".repeat(43), newPassword: `Reset-${stamp}-pw-${i}-xx` } }) });
  add({ route: "POST /auth/email/verify", name: "verify e-mail, invalid token", ...PUB, expect: [400], req: () => ({ method: "POST", path: "/auth/email/verify", body: { token: "B".repeat(43) } }) });
  add({ route: "POST /auth/email/resend", name: "resend verification", ...PUB, expect: [202], req: (i) => ({ method: "POST", path: "/auth/email/resend", body: { email: `sweep-c-${stamp}-${i % 100}@example.test` } }) });
  add({ route: "POST /auth/login-throttle/unlock", name: "admin unlock", actor: "platform", expect: [204], req: (i) => ({ method: "POST", path: "/auth/login-throttle/unlock", body: { email: A.travelers[i % 30].email } }) });
  add({ route: "GET /auth/mfa", name: "mfa status", actor: "traveler", req: () => ({ method: "GET", path: "/auth/mfa" }) });
  // MFA cycle on a dedicated account: setup, enable, regenerate recovery codes, disable (each timed separately by the runner).
  add({
    route: "POST /auth/mfa/*", name: "mfa cycle (setup, enable, recovery-codes, disable)",
    custom: async (i, t) => {
      const email = A.travelers[34].email;
      await w.sql.query('UPDATE users SET "mfaSecretEnc" = NULL, "mfaEnabledAt" = NULL, "mfaLastStep" = NULL, "mfaRecoveryHashes" = \'[]\' WHERE "emailNormalized" = $1', [email]);
      const l = await w.login(email, A.tenantCode);
      const token = l.body.accessToken;
      const setup = await t("mfa setup", "POST /auth/mfa/setup", "POST", "/auth/mfa/setup", { token, body: { password: A.password } }, [200]);
      const secret = setup.body?.secret;
      await w.resetMfaStep(email);
      await t("mfa enable", "POST /auth/mfa/enable", "POST", "/auth/mfa/enable", { token, body: { code: w.totp(secret) } }, [200]);
      await w.resetMfaStep(email);
      await t("mfa regenerate recovery codes", "POST /auth/mfa/recovery-codes", "POST", "/auth/mfa/recovery-codes", { token, body: { password: A.password, code: w.totp(secret) } }, [200]);
      await w.resetMfaStep(email);
      await t("mfa disable", "POST /auth/mfa/disable", "POST", "/auth/mfa/disable", { token, body: { password: A.password, code: w.totp(secret) } }, [204]);
    }
  });

  // ---------------------------------------------------------------- users and invitations
  add({ route: "GET /users/me", name: "profile", actor: "traveler", req: () => ({ method: "GET", path: "/users/me" }) });
  add({ route: "PATCH /users/me", name: "update profile", actor: "traveler", req: (i) => ({ method: "PATCH", path: "/users/me", body: { displayName: `Traveler ${i % 7}`, phone: "+966500000000", locale: i % 2 ? "ar-SA" : "en-US" } }) });
  add({ route: "GET /users/me/invitations", name: "my invitations", actor: "traveler", req: () => ({ method: "GET", path: "/users/me/invitations" }) });
  for (const verb of ["accept", "decline"])
    add({ route: `POST /users/me/invitations/:membershipId/${verb}`, name: `${verb} invitation`, expect: [200, 201, 204],
      prep: async (i) => { const m = st.invitations[i % st.invitations.length]; await w.sql.query("UPDATE tenant_memberships SET status = 'INVITED', \"awaitingOwnerConsent\" = true, \"revokedAt\" = NULL WHERE id = $1", [m.membershipId]); return { m, s: await w.session(`inv-${i % st.invitations.length}`, m.email, A.tenantCode) }; },
      req: (i, p) => ({ method: "POST", path: `/users/me/invitations/${p.m.membershipId}/${verb}`, token: p.s.token }) });

  // ---------------------------------------------------------------- tenant
  add({ route: "GET /tenants/current", name: "current tenant", actor: "admin", req: () => ({ method: "GET", path: "/tenants/current" }) });
  add({ route: "PATCH /tenants/current", name: "update tenant settings", actor: "admin", req: (i) => ({ method: "PATCH", path: "/tenants/current", body: { settings: { locale: i % 2 ? "ar-SA" : "en-US", currency: "SAR" } } }) });
  add({ route: "GET /tenants/members", name: "members list (no search)", actor: "admin", req: () => ({ method: "GET", path: "/tenants/members" }) });
  add({ route: "GET /tenants/members", name: "members search q=user00", actor: "admin", req: () => ({ method: "GET", path: "/tenants/members?q=user00" }) });
  add({ route: "GET /tenants/members", name: "members search q=History User 7", actor: "admin", req: () => ({ method: "GET", path: "/tenants/members?q=History%20User%207" }) });
  add({ route: "PATCH /tenants/members/:membershipId/status", name: "member status toggle", actor: "admin", req: (i) => ({ method: "PATCH", path: `/tenants/members/${st.spareMembers[i % st.spareMembers.length].membershipId}/status`, body: { status: Math.floor(i / st.spareMembers.length) % 2 ? "ACTIVE" : "SUSPENDED", reason: "sweep check" } }) });
  add({ route: "GET /tenants/members/:membershipId/history", name: "member history (heavy traveler)", actor: "admin", req: (i) => ({ method: "GET", path: `/tenants/members/${st.heavyMemberships[i % st.heavyMemberships.length]}/history` }) });
  add({ route: "GET /access/audit", name: "tenant audit, limit 50", actor: "admin", req: () => ({ method: "GET", path: "/access/audit?limit=50" }) });
  add({ route: "GET /access/audit", name: "tenant audit, limit 500", actor: "admin", req: () => ({ method: "GET", path: "/access/audit?limit=500" }) });

  // ---------------------------------------------------------------- roles and permissions
  add({ route: "GET /roles", name: "roles", actor: "admin", req: () => ({ method: "GET", path: "/roles" }) });
  add({ route: "GET /permissions", name: "permissions", actor: "admin", req: () => ({ method: "GET", path: "/permissions" }) });
  add({ route: "POST /roles", name: "create role", actor: "admin", expect: [201], req: (i) => ({ method: "POST", path: "/roles", body: { code: `sweep-r${stamp}-${i}`.toLowerCase(), name: `Sweep role ${i}`, description: "sweep", permissions: ["catalog.service.read", "booking.read"] } }), after: (r) => { if (r.status === 201) st.sweepRoles.push(r.body.id); } });
  add({ route: "PATCH /roles/:id", name: "update role", actor: "admin", req: (i) => ({ method: "PATCH", path: `/roles/${st.sweepRoles[i % Math.max(1, st.sweepRoles.length)]}`, body: { name: `Sweep role renamed ${i}`, permissions: ["catalog.service.read"] } }) });
  add({ route: "PUT /memberships/:membershipId/roles", name: "assign roles", actor: "admin", req: (i) => ({ method: "PUT", path: `/memberships/${st.spareMembers[i % st.spareMembers.length].membershipId}/roles`, body: { roleIds: [st.roleIds.traveler] } }) });
  add({ route: "DELETE /roles/:id", name: "delete role", actor: "admin", expect: [200, 204], n: 150, req: (i) => ({ method: "DELETE", path: `/roles/${st.sweepRoles[i]}` }) });

  // ---------------------------------------------------------------- catalogue
  add({ route: "GET /services", name: "services (provider's own)", actor: "provider", req: () => ({ method: "GET", path: "/services" }) });
  add({ route: "GET /services", name: "services (admin, all)", actor: "admin", req: () => ({ method: "GET", path: "/services?limit=200" }) });
  add({ route: "GET /services/marketplace", name: "marketplace page 1", actor: "traveler", req: (i) => ({ method: "GET", path: "/services/marketplace" }) });
  add({ route: "GET /services/marketplace", name: "marketplace limit 200", actor: "traveler", req: () => ({ method: "GET", path: "/services/marketplace?limit=200" }) });
  add({ route: "GET /services/exchange-rates", name: "exchange rates", actor: "traveler", req: () => ({ method: "GET", path: "/services/exchange-rates" }) });
  add({ route: "POST /services", name: "create service", actor: "provider", expect: [201], req: (i) => ({ method: "POST", path: "/services", body: { title: `Sweep service ${stamp} ${i}`, description: "Sweep package with enough description text", category: "PACKAGE", city: "Makkah", priceCents: 120000, capacity: 500, details: { durationDays: "5", departureCity: "Riyadh", itinerary: "sweep" } } }), after: (r) => { if (r.status === 201) st.sweepServices.push(r.body.id); } });
  add({ route: "PATCH /services/:id", name: "update service", actor: "provider", req: (i) => ({ method: "PATCH", path: `/services/${st.ownServices[i % st.ownServices.length]}`, body: { description: `Updated sweep description ${i % 9}`, priceCents: 100000 + (i % 50) * 100 } }) });

  // ---------------------------------------------------------------- bookings
  add({ route: "GET /bookings", name: "bookings (traveler, own)", actor: "traveler", req: (i) => ({ method: "GET", path: "/bookings" }) });
  add({ route: "GET /bookings", name: "bookings (provider)", actor: "provider", req: () => ({ method: "GET", path: "/bookings" }) });
  add({ route: "GET /bookings", name: "bookings (admin) page 1, limit 100", actor: "admin", req: () => ({ method: "GET", path: "/bookings" }) });
  add({ route: "GET /bookings", name: "bookings (admin) limit 200", actor: "admin", req: () => ({ method: "GET", path: "/bookings?limit=200" }) });
  for (const depth of [10, 50, "max"])
    add({ route: "GET /bookings", name: `bookings (admin) cursor depth ${depth}`, actor: "admin", req: () => ({ method: "GET", path: `/bookings?limit=100${st.cursors.bookings[depth] ? `&cursor=${st.cursors.bookings[depth]}` : ""}` }) });
  add({ route: "GET /bookings", name: "bookings (admin) legacy offset=1000", actor: "admin", req: () => ({ method: "GET", path: "/bookings?limit=100&offset=1000" }) });
  add({ route: "POST /bookings", name: "create booking", actor: "traveler", expect: [201], prep: null,
    req: (i) => ({ method: "POST", path: "/bookings", body: { serviceId: st.bookableServices[i % st.bookableServices.length], travelersCount: 2, serviceDate: days(10 + (i % 300)), notes: "sweep booking" }, headers: { "idempotency-key": `sweep-${stamp}-${i}` } }),
    after: async (r, i) => { if (r.status === 201) { const s = await w.actor("traveler", i); await call(base, "PATCH", `/bookings/${r.body.id}/status`, { token: s.token, body: { status: "CANCELLED" } }); } } });
  add({ route: "PATCH /bookings/:id", name: "edit pending booking", prep: async (i) => createPending(i, 20), req: (i, p) => ({ method: "PATCH", path: `/bookings/${p.id}`, token: p.session.token, body: { travelersCount: 3, notes: "edited by sweep" } }), after: async (r, i, p) => cancel(p) });
  add({ route: "PATCH /bookings/:id/status", name: "confirm booking (provider)", actor: "provider", prep: async (i) => createPending(i, 40), req: (i, p) => ({ method: "PATCH", path: `/bookings/${p.id}/status`, body: { status: "CONFIRMED" } }), after: async (r, i, p) => cancel(p) });
  add({ route: "PATCH /bookings/:id/status", name: "cancel booking (traveler)", prep: async (i) => createPending(i, 60), req: (i, p) => ({ method: "PATCH", path: `/bookings/${p.id}/status`, token: p.session.token, body: { status: "CANCELLED" } }) });

  // ---------------------------------------------------------------- providers and organisation workspace
  add({ route: "GET /providers/workspace", name: "provider workspace", actor: "provider", req: () => ({ method: "GET", path: "/providers/workspace" }) });
  add({ route: "GET /providers", name: "providers list (admin)", actor: "admin", req: () => ({ method: "GET", path: "/providers" }) });
  add({ route: "POST /providers", name: "create provider (admin)", actor: "admin", expect: [201], req: (i) => ({ method: "POST", path: "/providers", body: { name: `Sweep Provider ${stamp} ${i}`, nameAr: `Sweep Provider ${stamp} ${i}`, nameEn: `Sweep Provider ${stamp} ${i}`, type: "TRAVEL_COMPANY", city: "Riyadh", contactEmail: `sweep-prov-${stamp}-${i}@example.test`, phone: "", licenseNumber: `LP-${stamp}-${i}`, password: `Sweep-${stamp}-prov-${i}-x` } }), after: (r) => { if (r.status === 201) st.sweepProviders.push(r.body.id ?? r.body.organization?.id); } });
  add({ route: "PATCH /providers/:id", name: "update provider", actor: "admin", req: (i) => ({ method: "PATCH", path: `/providers/${st.sweepProviders[i % Math.max(1, st.sweepProviders.length)]}`, body: { city: i % 2 ? "Jeddah" : "Riyadh" } }) });
  add({ route: "PATCH /providers/:id/status", name: "provider status toggle", actor: "admin", req: (i) => ({ method: "PATCH", path: `/providers/${st.sweepProviders[i % Math.max(1, st.sweepProviders.length)]}/status`, body: { status: Math.floor(i / Math.max(1, st.sweepProviders.length)) % 2 ? "ACTIVE" : "SUSPENDED" } }) });
  const org = `/organizations/${A.orgmgr.organizationId}`;
  add({ route: "GET /organizations/:organizationId/management", name: "org management", actor: "orgmgr", req: () => ({ method: "GET", path: `${org}/management` }) });
  add({ route: "PATCH /organizations/:organizationId/specialties", name: "org specialties", actor: "orgmgr", req: (i) => ({ method: "PATCH", path: `${org}/specialties`, body: { specialties: ["umrah", `s${i % 5}`] } }) });
  add({ route: "POST /organizations/:organizationId/departments", name: "create department", actor: "orgmgr", expect: [201], req: (i) => ({ method: "POST", path: `${org}/departments`, body: { code: `dep-${stamp}-${i}`, name: `Dept ${i}` } }), after: (r) => { if (r.status === 201) st.departments.push(r.body.id); } });
  add({ route: "PATCH /organizations/:organizationId/departments/:departmentId", name: "update department", actor: "orgmgr", req: (i) => ({ method: "PATCH", path: `${org}/departments/${st.departments[i % Math.max(1, st.departments.length)]}`, body: { name: `Dept renamed ${i}`, active: true } }) });
  add({ route: "POST /organizations/:organizationId/roles", name: "create org role", actor: "orgmgr", expect: [201], req: (i) => ({ method: "POST", path: `${org}/roles`, body: { code: `or-${stamp}-${i}`, name: `Org role ${i}`, permissions: ["catalog.service.read"] } }), after: (r) => { if (r.status === 201) st.orgRoles.push(r.body.id); } });
  add({ route: "PATCH /organizations/:organizationId/roles/:roleId", name: "update org role", actor: "orgmgr", req: (i) => ({ method: "PATCH", path: `${org}/roles/${st.orgRoles[i % Math.max(1, st.orgRoles.length)]}`, body: { name: `Org role renamed ${i}`, permissions: ["catalog.service.read", "booking.read"] } }) });
  add({ route: "POST /organizations/:organizationId/employees", name: "create employee", actor: "orgmgr", expect: [201], req: (i) => ({ method: "POST", path: `${org}/employees`, body: { email: `sweep-emp-${stamp}-${i}@example.test`, displayName: `Employee ${i}`, password: `Sweep-${stamp}-emp-${i}-x`, jobTitle: "Agent", departmentId: st.departments[i % Math.max(1, st.departments.length)], roleIds: [st.orgRoles[i % Math.max(1, st.orgRoles.length)]] } }), after: (r) => { if (r.status === 201) st.employees.push(r.body.membershipId ?? r.body.id); } });
  add({ route: "PATCH /organizations/:organizationId/employees/:membershipId", name: "update employee", actor: "orgmgr", req: (i) => ({ method: "PATCH", path: `${org}/employees/${st.employees[i % Math.max(1, st.employees.length)]}`, body: { jobTitle: `Senior Agent ${i % 4}` } }) });

  // ---------------------------------------------------------------- platform administration (second factor on every call)
  add({ route: "GET /platform/overview", name: "platform overview (cached 30 s)", actor: "platform", req: () => ({ method: "GET", path: "/platform/overview" }) });
  add({ route: "GET /platform/overview", name: "platform overview (cold, 31 s apart)", actor: "platform", n: 6, prep: async (i) => { if (i > 0) await sleep(31_000); }, req: () => ({ method: "GET", path: "/platform/overview" }) });
  add({ route: "GET /platform/references", name: "platform references", actor: "platform", req: () => ({ method: "GET", path: "/platform/references" }) });
  const rec = (kind, query, label) => add({ route: "GET /platform/records/:kind", name: `records ${kind} ${label}`, actor: "platform", req: () => ({ method: "GET", path: `/platform/records/${kind}${query}` }) });
  for (const kind of ["users", "services", "bookings", "providers", "tenants", "audit", "sessions"]) {
    rec(kind, "?page=1", "page 1");
    rec(kind, "?page=100", "page 100 (offset 2,970)");
    rec(kind, "?page=1000", "page 1000 (offset 29,970)");
  }
  rec("users", "?page=1&q=user00", "search q=user00");
  rec("users", "?page=1&q=History%20User%2077", "search by name");
  rec("users", `?page=1&tenantId=${A.tenantId}`, "filter tenant");
  rec("bookings", "?page=1&q=user0042", "search q=user0042");
  rec("bookings", "?page=1&q=Service%202", "search by service title");
  rec("audit", "?page=1&q=booking.create", "search action");
  rec("audit", "?page=1&q=user00", "search actor e-mail");
  rec("audit", `?page=1&tenantId=${A.tenantId}`, "filter tenant");
  rec("sessions", "?page=1&q=user00", "search e-mail");
  rec("sessions", `?page=1&tenantId=${A.tenantId}`, "filter tenant");
  rec("services", "?page=1&q=Service", "search q=Service");
  add({ route: "GET /platform/tenants", name: "platform tenants list", actor: "platform", req: () => ({ method: "GET", path: "/platform/tenants" }) });
  add({ route: "GET /platform/tenants/:id/activity", name: "tenant activity", actor: "platform", req: () => ({ method: "GET", path: `/platform/tenants/${A.tenantId}/activity` }) });
  add({ route: "POST /platform/tenants", name: "create tenant", actor: "platform", expect: [201], req: (i) => ({ method: "POST", path: "/platform/tenants", body: { code: `sweep-t-${stamp}-${i}`, name: `Sweep tenant ${i}` } }), after: (r) => { if (r.status === 201) st.sweepTenants.push(r.body.id); } });
  add({ route: "POST /platform/tenants/:id/status", name: "tenant status toggle", actor: "platform", expect: [200, 201, 204], req: (i) => ({ method: "POST", path: `/platform/tenants/${st.sweepTenants[i % Math.max(1, st.sweepTenants.length)]}/status`, body: { status: Math.floor(i / Math.max(1, st.sweepTenants.length)) % 2 ? "ACTIVE" : "SUSPENDED", reason: "sweep check" } }) });
  add({ route: "POST /platform/users", name: "platform creates account", actor: "platform", expect: [201], prep: async () => w.stepUp(), req: (i, p) => ({ method: "POST", path: "/platform/users", body: { displayName: `Created ${i}`, email: `sweep-pu-${stamp}-${i}@example.test`, phone: "", password: `Sweep-${stamp}-pu-${i}-x`, tenantId: A.tenantId, roleId: st.roleIds.traveler, ...p } }), after: (r) => { if (r.status === 201) st.platformUsers.push(r.body.id ?? r.body.user?.id); } });
  add({ route: "PATCH /platform/users/:id", name: "platform updates account", actor: "platform", prep: async () => w.stepUp(), req: (i, p) => ({ method: "PATCH", path: `/platform/users/${st.platformUsers[i % Math.max(1, st.platformUsers.length)]}`, body: { displayName: `Renamed ${i % 9}`, ...p } }) });
  add({ route: "POST /platform/users/:id/state", name: "platform account state toggle", actor: "platform", expect: [200, 201, 204], prep: async () => w.stepUp(), req: (i, p) => ({ method: "POST", path: `/platform/users/${st.platformUsers[i % Math.max(1, st.platformUsers.length)]}/state`, body: { action: Math.floor(i / Math.max(1, st.platformUsers.length)) % 2 ? "ACTIVE" : "SUSPENDED", reason: "sweep check", ...p } }) });
  add({ route: "POST /platform/users/:id/revoke-sessions", name: "platform revokes sessions", actor: "platform", expect: [200, 201, 204], prep: async () => w.stepUp(), req: (i, p) => ({ method: "POST", path: `/platform/users/${st.platformUsers[i % Math.max(1, st.platformUsers.length)]}/revoke-sessions`, body: { ...p } }) });
  add({ route: "PATCH /platform/memberships/:id/access", name: "platform sets membership access", actor: "platform", prep: async () => w.stepUp(), req: (i, p) => ({ method: "PATCH", path: `/platform/memberships/${st.spareMembers[i % st.spareMembers.length].membershipId}/access`, body: { roleIds: [st.roleIds.traveler], permissionOverrides: {}, status: "ACTIVE", ...p } }) });
  return cases;
}
