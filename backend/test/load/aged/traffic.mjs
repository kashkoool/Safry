// Open-loop mixed traffic generator shared by the soak, the retention-under-load test and the restart probe.
import { call, stats, round } from "./common.mjs";

/** Weighted request mix of a normal day: mostly traveler reads, some writes, a few staff and admin pages, a few sign-ins. */
export function makeMix(w, st) {
  const A = w.actors;
  const base = w.run.base;
  const trav = (i) => w.actor("traveler", i);
  const days = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
  let n = 0;
  const mix = [
    [25, "GET /bookings (traveler)", async (i) => ({ method: "GET", path: "/bookings?limit=20", token: (await trav(i)).token })],
    [15, "GET /services/marketplace", async (i) => ({ method: "GET", path: "/services/marketplace?limit=20", token: (await trav(i)).token })],
    [10, "GET /auth/me", async (i) => ({ method: "GET", path: "/auth/me", token: (await trav(i)).token })],
    [8, "POST /auth/activity", async (i) => ({ method: "POST", path: "/auth/activity", token: (await trav(i)).token })],
    [6, "POST /auth/refresh", async (i) => {
      // one in-flight refresh per chain: presenting the same refresh token twice is (correctly) treated as token reuse
      const chain = (st.chains ??= {}); const busy = (st.busy ??= new Set());
      let k = i % 36; for (let t = 0; t < 36 && busy.has(k); t++) k = (k + 1) % 36;
      if (busy.has(k)) return { method: "GET", path: "/auth/me", token: (await trav(i)).token };
      busy.add(k);
      if (!chain[k]) chain[k] = (await w.login(A.travelers[k].email, A.tenantCode)).body.refreshToken;
      return { method: "POST", path: "/auth/refresh", body: { refreshToken: chain[k] }, after: (r) => { busy.delete(k); if (r.status === 200) chain[k] = r.body.refreshToken; else delete chain[k]; } };
    }],
    [5, "GET /users/me", async (i) => ({ method: "GET", path: "/users/me", token: (await trav(i)).token })],
    [4, "POST /bookings (+cancel)", async (i) => {
      const s = await trav(i);
      return { method: "POST", path: "/bookings", token: s.token, body: { serviceId: st.bookable[i % st.bookable.length], travelersCount: 2, serviceDate: days(10 + (++n % 300)) },
        after: async (r) => { if (r.status === 201) await call(base, "PATCH", `/bookings/${r.body.id}/status`, { token: s.token, body: { status: "CANCELLED" } }); } };
    }],
    [5, "GET /bookings (provider)", async () => ({ method: "GET", path: "/bookings?limit=50", token: (await w.actor("provider")).token })],
    [2, "GET /services (provider)", async () => ({ method: "GET", path: "/services", token: (await w.actor("provider")).token })],
    [3, "GET /bookings (admin)", async () => ({ method: "GET", path: "/bookings?limit=50", token: (await w.actor("admin")).token })],
    [1, "GET /tenants/members (admin)", async () => ({ method: "GET", path: "/tenants/members", token: (await w.actor("admin")).token })],
    [1, "GET /access/audit (admin)", async () => ({ method: "GET", path: "/access/audit?limit=50", token: (await w.actor("admin")).token })],
    [1, "GET /platform/records/bookings", async () => ({ method: "GET", path: "/platform/records/bookings?page=1", token: (await w.actor("platform")).token })],
    [0.6, "POST /auth/login (ok)", async (i) => ({ method: "POST", path: "/auth/login", body: { email: A.travelers[i % 36].email, password: A.password, tenantCode: A.tenantCode } })],
    [0.4, "POST /auth/login (wrong password)", async (i) => ({ method: "POST", path: "/auth/login", body: { email: A.travelers[i % 36].email, password: "Wrong-password-1", tenantCode: A.tenantCode }, okStatus: [401] })],
    [0.2, "POST /auth/password/forgot", async (i) => ({ method: "POST", path: "/auth/password/forgot", body: { email: A.travelers[i % 30].email }, okStatus: [202] })],
    [1, "GET unknown route (404)", async () => ({ method: "GET", path: "/does-not-exist", okStatus: [404] })]
  ];
  const total = mix.reduce((s, m) => s + m[0], 0);
  return { mix, pick(rnd) { let x = rnd * total; for (const m of mix) { x -= m[0]; if (x < 0) return m; } return mix[0]; } };
}

/**
 * Fires requests at `rate` per second (open loop) until stopped. Records every response as { t, name, status, ms }.
 * Returns { stop(), samples, dropped }.
 */
export function startTraffic(w, st, { rate, maxInFlight = 400 }) {
  const m = makeMix(w, st);
  const samples = [];
  let inflight = 0, dropped = 0, i = 0, stopped = false;
  const fire = async () => {
    if (inflight >= maxInFlight) { dropped += 1; return; }
    const idx = i++;
    const [, name, build] = m.pick(Math.random());
    inflight += 1;
    const t = Date.now();
    try {
      const req = await build(idx);
      let r = await call(w.run.base, req.method, req.path, { token: req.token, body: req.body });
      if (r.status === 401 && req.token) { w.sessions.clear(); const again = await build(idx); r = await call(w.run.base, again.method, again.path, { token: again.token, body: again.body }); }
      const ok = (req.okStatus ?? [200, 201, 204]).includes(r.status);
      samples.push({ t, name, status: r.status, ms: r.ms, ok });
      if (req.after) await req.after(r);
    } catch (e) {
      samples.push({ t, name, status: -1, ms: Date.now() - t, ok: false, err: String(e.message).slice(0, 80) });
    } finally { inflight -= 1; }
  };
  const timer = setInterval(() => { if (!stopped) void fire(); }, 1000 / rate);
  return { samples, stop() { stopped = true; clearInterval(timer); }, get dropped() { return dropped; }, get inflight() { return inflight; } };
}

/** Signs every actor in once, one after the other, before the load starts (a cold start would otherwise sign in 40 actors at once). */
export async function prewarm(w, st) {
  for (let i = 0; i < 36; i++) await w.actor("traveler", i);
  await w.actor("provider"); await w.actor("admin"); await w.actor("platform");
  st.chains ??= {};
  for (let k = 0; k < 36; k++) st.chains[k] = (await w.login(w.actors.travelers[k].email, w.actors.tenantCode)).body.refreshToken;
}

/** Summary of samples in [from, to): overall and per endpoint. */
export function summarize(samples, from, to) {
  const rows = samples.filter((s) => s.t >= from && s.t < to);
  const per = {};
  for (const s of rows) (per[s.name] ??= []).push(s);
  const side = (arr) => { const st = stats(arr.filter((s) => s.ok).map((s) => s.ms)); return { n: arr.length, ok: arr.filter((s) => s.ok).length, s5xx: arr.filter((s) => s.status >= 500).length, s429: arr.filter((s) => s.status === 429).length, neterr: arr.filter((s) => s.status <= 0).length, p50: round(st.p50), p95: round(st.p95), p99: round(st.p99), max: round(st.max) }; };
  return { all: side(rows), per: Object.fromEntries(Object.entries(per).map(([k, v]) => [k, side(v)])) };
}
