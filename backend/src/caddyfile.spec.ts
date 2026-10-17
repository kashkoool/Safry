import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const caddyfile = readFileSync(new URL("../../deploy/caddy/Caddyfile.cloudflare", import.meta.url), "utf8");
const text = caddyfile.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
const trustedAt = text.indexOf("handle @cloudflare");
const fallbackAt = text.search(/^\thandle \{/m);

describe("Caddyfile.cloudflare", () => {
  it("believes CF-Connecting-IP only inside the block matched by the Cloudflare ranges", () => {
    expect(text).toMatch(/^\s*@cloudflare remote_ip \{\$CLOUDFLARE_IP_RANGES\}\s*$/m);
    expect(trustedAt).toBeGreaterThan(-1);
    expect(fallbackAt).toBeGreaterThan(trustedAt);
    const uses = [...text.matchAll(/header_up X-Forwarded-For \{header\.CF-Connecting-IP\}/g)];
    expect(uses.length).toBe(1);
    expect(uses[0]?.index ?? -1).toBeGreaterThan(trustedAt);
    expect(uses[0]?.index ?? -1).toBeLessThan(fallbackAt);
  });
  it("keys every other caller by its own connection address and drops its forged header", () => {
    const fallback = text.slice(fallbackAt);
    expect(fallback).toContain("header_up X-Forwarded-For {remote_host}");
    expect(fallback).toContain("header_up -CF-Connecting-IP");
    expect(fallback).not.toMatch(/header_up X-Forwarded-For \{header\./);
  });
});
