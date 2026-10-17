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

  const INCLUDE = "include /etc/nginx/snippets/security-headers.conf;";
  const block = (head: string): string => {
    const start = server.indexOf(head);
    expect(start, `${head} exists in nginx.conf`).toBeGreaterThan(-1);
    return server.slice(start, server.indexOf("\n  }", start));
  };

  it("the server block includes the snippet", () => {
    expect(server.slice(0, server.indexOf("location")).includes(INCLUDE)).toBe(true);
  });

  // nginx drops inherited add_header lines in a location that sets its own, so each such location must repeat the include.
  it.each(["location /api/ {", "location /assets/ {", "location = /favicon.svg {", "location / {"])("%s includes the snippet", (head) => {
    expect(block(head)).toContain(INCLUDE);
  });
});
