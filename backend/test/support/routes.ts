import "reflect-metadata";
import { RequestMethod } from "@nestjs/common";

// Importing the compiled AppModule validates the environment at import time; nothing connects anywhere. These dummy
// values only satisfy that validation when the caller (the route-coverage gate) has no .env or database configured.
process.env["NODE_ENV"] ??= "test";
process.env["DATABASE_URL"] ??= "postgresql://nobody:nothing@127.0.0.1:1/none";
process.env["JWT_ACCESS_SECRET"] ??= "route-discovery-only-secret-with-more-than-32-chars";
const { AppModule } = (await import("../../dist/app.module.js")) as { AppModule: unknown };

/** Nest stores route data under these reflect-metadata keys (see @nestjs/common constants). */
const METADATA = { imports: "imports", controllers: "controllers", path: "path", method: "method" } as const;

type Klass = new (...args: never[]) => unknown;
type ModuleRef = Klass | { module: Klass };

const METHOD_NAMES: Partial<Record<number, string>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.ALL]: "ALL",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD"
};

const asPaths = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]) : [(value as string | undefined) ?? ""]);
const clean = (segment: string): string => segment.split("/").filter(Boolean).join("/");

function collectControllers(root: ModuleRef): Klass[] {
  const seen = new Set<unknown>();
  const found = new Set<Klass>();
  const visit = (ref: ModuleRef): void => {
    const klass = "module" in ref ? ref.module : ref;
    if (seen.has(klass)) return;
    seen.add(klass);
    const own = [...((Reflect.getMetadata(METADATA.controllers, klass) as Klass[] | undefined) ?? []), ...(("controllers" in ref ? (ref as { controllers?: Klass[] }).controllers : undefined) ?? [])];
    for (const controller of own) found.add(controller);
    const imports = [...((Reflect.getMetadata(METADATA.imports, klass) as ModuleRef[] | undefined) ?? []), ...(("imports" in ref ? (ref as { imports?: ModuleRef[] }).imports : undefined) ?? [])];
    for (const child of imports) visit(child);
  };
  visit(root);
  return [...found];
}

/** Every HTTP route the compiled app registers, as "METHOD /path/:param" (global prefix omitted). */
export function discoverRoutes(): string[] {
  const keys = new Set<string>();
  for (const controller of collectControllers(AppModule as unknown as Klass)) {
    const base = asPaths(Reflect.getMetadata(METADATA.path, controller));
    const prototype = controller.prototype as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(prototype)) {
      const handler = prototype[name];
      if (typeof handler !== "function") continue;
      const method = Reflect.getMetadata(METADATA.method, handler) as number | undefined;
      if (method === undefined) continue;
      for (const prefix of base)
        for (const path of asPaths(Reflect.getMetadata(METADATA.path, handler)))
          keys.add(`${METHOD_NAMES[method] ?? String(method)} /${[clean(prefix), clean(path)].filter(Boolean).join("/")}`);
    }
  }
  return [...keys].sort();
}

/** Every controller class the compiled app registers (the same walk discoverRoutes uses). */
export function discoverControllers(): Klass[] {
  return collectControllers(AppModule as unknown as Klass);
}
