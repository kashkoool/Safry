import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    /** Set when TEST_APP_AS_RUNTIME=1: the restricted production-style login the application under test connects as ("" otherwise). */
    runtimeDatabaseUrl: string;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolvePort(address.port) : reject(new Error("no port"))));
    });
  });
}

function migrate(root: string, url: string): void {
  execFileSync(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe"
  });
}

/**
 * TEST_DATABASE_URL (optional): an external PostgreSQL server (for example a Linux container) to use
 * instead of the embedded one. A fresh, randomly named database is created there and dropped afterwards.
 */
/**
 * Several tests age rows with SQL `now() - interval ...` while the application compares them with its own `new Date()`.
 * A database server whose clock differs from this host (a Docker Desktop/WSL VM clock that drifted or was set from local time
 * after sleep/resume shows up as a constant offset such as +3h) makes those tests fail in confusing ways, so refuse to start.
 */
async function assertClocksAgree(admin: { query: (sql: string) => Promise<{ rows: Array<Record<string, unknown>> }> }): Promise<void> {
  const before = Date.now();
  const { rows } = await admin.query("SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms");
  const after = Date.now();
  const skew = Number(rows[0]!["ms"]) - (before + after) / 2;
  if (Math.abs(skew) > 2_000)
    throw new Error(`Test database clock differs from this host by ${Math.round(skew / 1000)} s: restart Docker/WSL (wsl --shutdown) or sync its clock before running the integration suite`);
}

async function external(project: TestProject, root: string, serverUrl: string): Promise<() => Promise<void>> {
  const { default: pg } = await import("pg");
  const name = `safry_test_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: serverUrl });
  await admin.connect();
  await assertClocksAgree(admin);
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  migrate(root, url.toString());
  project.provide("databaseUrl", url.toString());
  // TEST_APP_AS_RUNTIME=1: the app under test connects as the restricted production login (NOBYPASSRLS,
  // member of safry_app, as scripts/db/create-runtime-role.sql creates it) instead of the superuser; fixtures keep using
  // the superuser. A superuser app login hides every defect that only appears under row-level security.
  let runtimeRole: string | undefined;
  let runtimeUrl = "";
  if (process.env["TEST_APP_AS_RUNTIME"] === "1") {
    runtimeRole = `safry_runtime_${randomUUID().replaceAll("-", "").slice(0, 10)}`;
    const password = randomBytes(18).toString("hex");
    await admin.query(`CREATE ROLE ${runtimeRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION INHERIT PASSWORD '${password}'`);
    await admin.query(`GRANT safry_app TO ${runtimeRole}`);
    await admin.query(`GRANT CONNECT ON DATABASE "${name}" TO ${runtimeRole}`);
    const login = new URL(url);
    login.username = runtimeRole;
    login.password = password;
    runtimeUrl = login.toString();
  }
  project.provide("runtimeDatabaseUrl", runtimeUrl);
  return async () => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    if (runtimeRole) await admin.query(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await admin.end();
  };
}

/** Starts a throw-away PostgreSQL, applies all Prisma migrations and hands the URL to the tests. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const root = resolve(import.meta.dirname, "../..");
  const serverUrl = process.env["TEST_DATABASE_URL"];
  if (serverUrl) return external(project, root, serverUrl);
  const dataDir = mkdtempSync(join(tmpdir(), "safry-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    // initdb otherwise takes the Windows code page (WIN1252) and migration 0003 (Arabic text) fails.
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    onLog: () => undefined,
    onError: () => undefined
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("safry_test");
  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/safry_test`;
  migrate(root, url);
  project.provide("databaseUrl", url);
  project.provide("runtimeDatabaseUrl", "");
  return async () => {
    await server.stop();
    rmSync(dataDir, { recursive: true, force: true });
  };
}
