// Bounded concurrency primitive. acquire() resolves with a release function;
// callers MUST invoke release in a finally block or the slot leaks.
//
// Used to enforce spec §8.2 caps during Scan Token funded-by fan-out:
// per-scan instance with capacity 10, plus a process-wide instance with
// capacity 50 imported from a shared singleton.

export class Semaphore {
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (capacity < 1) throw new Error("Semaphore capacity must be >= 1");
    this.available = capacity;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available--;
      return () => this.release();
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.available++;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

// Process-wide cap shared across all concurrent scans (spec §8.2: 50/process).
export const PROCESS_HELIUS_SEMAPHORE = new Semaphore(50);
