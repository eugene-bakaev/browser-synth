// Reject a promise that takes too long instead of awaiting it forever.
//
// Motivating case: the WS hello path reads the durable session from Postgres
// before it can send `welcome`. When the Supabase pooler wedges, that read can
// hang indefinitely — the client then spins on a loader with no error, no close.
// Racing the read against a timer turns an unbounded hang into a fast, handleable
// rejection so the connection can fail loudly and the client can retry.
//
// The source promise keeps running (we can't cancel an in-flight DB query); we
// just stop waiting. We still attach a handler to it so a late rejection after
// the timeout doesn't surface as an unhandled rejection.

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`operation timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
