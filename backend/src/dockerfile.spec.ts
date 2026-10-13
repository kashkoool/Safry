import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const stage = (name: string): string => {
  const parts = dockerfile.split(/^FROM .*$/m);
  const heads = [...dockerfile.matchAll(/^FROM .* AS (\w+)/gm)].map((m) => m[1]);
  return parts[heads.indexOf(name) + 1] ?? "";
};

describe("Dockerfile runtime stage", () => {
  it("is the last stage and sets UV_THREADPOOL_SIZE >= HASH_CONCURRENCY + 4", () => {
    const heads = [...dockerfile.matchAll(/^FROM .* AS (\w+)/gm)].map((m) => m[1]);
    expect(heads.at(-1)).toBe("runtime");
    const size = Number(/^ENV UV_THREADPOOL_SIZE=(\d+)/m.exec(stage("runtime"))?.[1]);
    expect(size).toBeGreaterThanOrEqual(4 + 4);
  });
  it("migrate stage installs OpenSSL for Prisma", () => {
    expect(stage("migrate")).toMatch(/apt-get install[^\n]*openssl/);
  });
  it("migrate stage fetches the Prisma engine at build time, as root, before dropping to the node user", () => {
    // With OpenSSL present Prisma wants its openssl-3 engine; the job runs as `node` on a read-only filesystem and cannot
    // download it ("Can't write to .../@prisma/engines").
    const migrate = stage("migrate");
    const fetchAt = migrate.search(/RUN node node_modules\/prisma\/build\/index\.js --version/);
    expect(fetchAt).toBeGreaterThan(migrate.search(/apt-get install[^\n]*openssl/));
    expect(fetchAt).toBeLessThan(migrate.search(/^USER node/m));
  });
});

describe("Node version consistency", () => {
  const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
  const ciMajor = /^\s*NODE_VERSION:\s*"?(\d+)/m.exec(read("../../.github/workflows/ci.yml"))?.[1];
  const nodeMajors = (text: string): string[] => [...text.matchAll(/^FROM node:(\d+)\./gm)].map((m) => m[1] as string);

  it("reads NODE_VERSION from the CI workflow", () => {
    expect(ciMajor).toMatch(/^\d+$/);
  });
  it.each([
    ["backend/Dockerfile", "../Dockerfile"],
    ["frontend/Dockerfile", "../../frontend/Dockerfile"]
  ])("%s only uses the Node major CI tests with", (_name, rel) => {
    const majors = nodeMajors(read(rel));
    expect(majors.length).toBeGreaterThan(0);
    expect(new Set(majors)).toEqual(new Set([ciMajor]));
  });
  it("pins the exact pnpm version with npm ci in both Dockerfiles", () => {
    for (const rel of ["../Dockerfile", "../../frontend/Dockerfile"]) {
      expect(read(rel)).toMatch(/npm ci --ignore-scripts --prefix \/opt\/pnpm/);
      expect(read(rel)).not.toMatch(/npm install -g/);
    }
  });
});
