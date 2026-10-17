import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const headers = readFileSync(new URL("../../frontend/nginx/security-headers.conf", import.meta.url), "utf8");
const server = readFileSync(new URL("../../frontend/nginx.conf", import.meta.url), "utf8");

describe("web server security headers", () => {
  it.each([
    ["Cross-Origin-Opener-Policy", "same-origin"],
    ["Cross-Origin-Resource-Policy", "same-origin"],
    ["Cross-Origin-Embedder-Policy", "require-corp"]
  ])("%s is %s on every response", (name, value) => {
    expect(headers).toMatch(new RegExp(`^add_header ${name} "${value}" always;`, "m"));
  });

  it("the snippet is included in the server block and in every location that sets its own headers", () => {
    const includes = server.match(/include \/etc\/nginx\/snippets\/security-headers\.conf;/g) ?? [];
    expect(includes.length).toBeGreaterThanOrEqual(2);
  });
});
