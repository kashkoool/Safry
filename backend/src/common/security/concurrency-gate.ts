/** Thrown when every slot is busy and the waiting queue is full (callers map it to 503). */
export class GateFullError extends Error {
  constructor() {
    super("Concurrency gate is full");
    this.name = "GateFullError";
  }
}

/** Runs at most `limit` tasks at once; up to `maxQueue` more wait in FIFO order, the rest are refused. */
export class ConcurrencyGate {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(
    private readonly limit: number,
    private readonly maxQueue: number
  ) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      if (this.waiting.length >= this.maxQueue) throw new GateFullError();
      // The slot is handed over directly by release(), so `active` stays constant across the hand-off.
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}
