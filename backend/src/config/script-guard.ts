/**
 * Destructive operational scripts (demo refresh, smoke test, demo grants) must not run against a real
 * database by accident. They are allowed only on a local database, never with
 * NODE_ENV=production, unless ALLOW_REMOTE_SCRIPT=true is set deliberately.
 */
export function scriptRefusal(env: Record<string, string | undefined>): string | undefined {
  if (env["ALLOW_REMOTE_SCRIPT"] === "true") return undefined;
  if (env["NODE_ENV"] === "production") return "NODE_ENV=production";
  const raw = env["DATABASE_URL"];
  if (!raw) return "DATABASE_URL is not set";
  let host: string;
  try {
    host = new URL(raw).hostname;
  } catch {
    return "DATABASE_URL is not a valid URL";
  }
  const local = host === "localhost" || host === "::1" || host === "[::1]" || /^127\./.test(host) || host === "host.docker.internal";
  return local ? undefined : "DATABASE_URL points to a non-local host";
}

export function assertDevDatabase(script: string, env: Record<string, string | undefined> = process.env): void {
  const reason = scriptRefusal(env);
  if (reason) throw new Error(`${script} refused to run: ${reason}. It changes data; set ALLOW_REMOTE_SCRIPT=true only if you really mean it.`);
}
