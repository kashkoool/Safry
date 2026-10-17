/** Error class and message LENGTH only: a message can carry a connection string, an e-mail address or a token. */
export function describeFatal(error: unknown): string {
  if (error instanceof Error) return `${error.constructor.name || error.name} (message of ${error.message.length} characters)`;
  return "a non-error value";
}

interface HandlerOptions {
  target: Pick<NodeJS.EventEmitter, "on">;
  log: (message: string) => void;
  /** The existing graceful path (readiness flips to draining, in-flight requests finish, pools close). */
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
}

/**
 * An unhandled rejection or uncaught exception leaves the process in an unknown state, so it must not keep serving: log what
 * kind of failure it was (never request data, never a stack to a client), run the normal drain, and exit non-zero so the
 * orchestrator restarts it. Only the first failure acts; the drain's own hard deadline (ShutdownState) bounds the wait.
 */
export function installProcessHandlers({ target, log, shutdown, exit }: HandlerOptions): void {
  let handling = false;
  const fatal = (source: string) => (error: unknown): void => {
    if (handling) return;
    handling = true;
    log(`${source}: ${describeFatal(error)}; shutting down`);
    shutdown().catch(() => undefined).finally(() => exit(1));
  };
  target.on("unhandledRejection", fatal("Unhandled promise rejection"));
  target.on("uncaughtException", fatal("Uncaught exception"));
}
