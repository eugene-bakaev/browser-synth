// Per-connection token bucket for inbound op rate limiting.
//
// Capacity 200 lets a client burst (e.g. a fast drag across a knob) without
// stalling, while the steady refill of 1 token per 10 ms = 100 ops/sec caps
// long-run sustained throughput. The bucket is owned by ConnectionHandler so
// each socket gets its own budget — no cross-client contention.
//
// `consume` accepts an optional `now` so tests can advance time deterministically
// without monkey-patching Date.now.

const CAPACITY = 200;
const REFILL_PER_TICK = 1;     // 1 token per 10 ms = 100/sec
const TICK_MS = 10;

export class TokenBucket {
  private tokens: number = CAPACITY;
  private lastRefill: number = Date.now();

  consume(now: number = Date.now()): boolean {
    const elapsed = now - this.lastRefill;
    if (elapsed >= TICK_MS) {
      const ticks = Math.floor(elapsed / TICK_MS);
      this.tokens = Math.min(CAPACITY, this.tokens + ticks * REFILL_PER_TICK);
      this.lastRefill += ticks * TICK_MS;
    }
    if (this.tokens > 0) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }
}
