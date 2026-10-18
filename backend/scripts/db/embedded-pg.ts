/**
 * Starts a local PostgreSQL 17 (the embedded one the tests use, no Docker), applies every migration and keeps running until Ctrl+C.
 * The data lives in backend/.local-pg (git-ignored) and survives restarts, so a seeded history is kept between sessions.
 *
 *   pnpm db:embedded                 # prints the connection URL, then waits
 *   pnpm seed:history -- --url <that url>
 *   pnpm db:size-report -- --url <that url>
 *
 * Set TZ=UTC PGTZ=UTC in the shell. Delete backend/.local-pg to start from nothing. Local development only.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";

const root = resolve(import.meta.dirname, "../..");
const dataDir = resolve(root, ".local-pg");
const port = Number(process.env["LOCAL_PG_PORT"] ?? 55432);
const first = !existsSync(resolve(dataDir, "PG_VERSION"));

mkdirSync(dataDir, { recursive: true });
const server = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: "postgres",
  password: "postgres",
  port,
  persistent: true,
  initdbFlags: ["--encoding=UTF8", "--locale=C"],
  onLog: (): void => undefined,
  onError: (): void => undefined
});
if (first) await server.initialise();
await server.start();
if (first) await server.createDatabase("safry_local");
const url = `postgresql://postgres:postgres@127.0.0.1:${port}/safry_local`;
execFileSync(process.execPath, [resolve(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], { cwd: root, env: { ...process.env, DATABASE_URL: url }, stdio: "pipe" });
console.log(`local PostgreSQL ready (throw-away credentials, loopback only):\n  ${url}\nPress Ctrl+C to stop.`);

const stop = async (): Promise<void> => {
  await server.stop();
  process.exit(0);
};
const onSignal = (): void => void stop();
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
await new Promise(() => undefined);
