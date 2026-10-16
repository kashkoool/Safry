import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it } from "vitest";
import { PlatformAdminGuard } from "../dist/common/security/platform-admin.guard.js";
import { PlatformModule } from "../dist/modules/platform/platform.module.js";
import { discoverControllers } from "./support/routes.js";

type Klass = new (...args: never[]) => unknown;

/**
 * Routes under a platform path that are deliberately NOT behind PlatformAdminGuard. Keep this list empty unless a route
 * is meant for non-administrators; each entry needs a written reason.
 */
const UNGUARDED_PLATFORM_ROUTES: Record<string, string> = {};

const guardsOf = (target: object): unknown[] => (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[] | undefined) ?? [];
const pathsOf = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : [(value as string | undefined) ?? ""]);

describe("platform controllers are guarded", () => {
  it("every route under a platform path, or declared in the platform module, carries PlatformAdminGuard", () => {
    const inPlatformModule = new Set((Reflect.getMetadata("controllers", PlatformModule) as Klass[] | undefined) ?? []);
    expect(inPlatformModule.size, "platform module lists its controllers").toBeGreaterThan(0);
    const checked: string[] = [];
    const missing: string[] = [];
    for (const controller of discoverControllers()) {
      const base = pathsOf(Reflect.getMetadata("path", controller)).map((p) => p.replace(/^\/+/, ""));
      const prototype = controller.prototype as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(prototype)) {
        const handler = prototype[name];
        if (typeof handler !== "function" || Reflect.getMetadata("method", handler) === undefined) continue;
        const paths = base.flatMap((prefix) => pathsOf(Reflect.getMetadata("path", handler)).map((p) => `${prefix}/${p}`.replace(/\/+$/, "")));
        const platform = inPlatformModule.has(controller) || paths.some((p) => p === "platform" || p.startsWith("platform/"));
        if (!platform) continue;
        const key = `${controller.name}.${name} (${paths.join(", ")})`;
        checked.push(key);
        const guarded = [...guardsOf(controller), ...guardsOf(handler)].includes(PlatformAdminGuard);
        if (!guarded && !(key in UNGUARDED_PLATFORM_ROUTES)) missing.push(key);
      }
    }
    expect(checked.length, "the walk found the platform routes").toBeGreaterThan(5);
    expect(missing, "platform routes without PlatformAdminGuard").toEqual([]);
  });
});
