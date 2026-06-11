// Keyed token buckets for route-level rate limiting (one bucket per caller
// key, e.g. IP). Same refill discipline as the per-connection TokenBucket in
// sync/rate-limit.ts, but parameterized and keyed: route abuse is per-caller,
// not per-socket.
//
// `consume` accepts an optional `now` so tests can advance time without
// monkey-patching Date.now.

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class KeyedTokenBucket {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillIntervalMs: number, // 1 token per interval
    private readonly maxKeys = 10_000,
  ) {}

  consume(key: string, now: number = Date.now()): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      // Bound memory under key churn (spoofed IPs): drop the oldest-inserted
      // bucket. Insertion order is a fair eviction proxy at this scale — an
      // evicted-and-recreated bucket refills to full, which only ever errs
      // permissive.
      if (this.buckets.size >= this.maxKeys) {
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { tokens: this.capacity, lastRefill: now };
      this.buckets.set(key, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    if (elapsed >= this.refillIntervalMs) {
      const ticks = Math.floor(elapsed / this.refillIntervalMs);
      bucket.tokens = Math.min(this.capacity, bucket.tokens + ticks);
      bucket.lastRefill += ticks * this.refillIntervalMs;
    }

    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }
}
