import { describe, it, expect, vi } from 'vitest';
import { withTimeout, TimeoutError } from './withTimeout.js';

describe('withTimeout', () => {
  it('resolves with the source value when it settles before the timeout', async () => {
    await expect(withTimeout(Promise.resolve(42), 1000)).resolves.toBe(42);
  });

  it('propagates the source rejection when it rejects before the timeout', async () => {
    await expect(withTimeout(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
  });

  it('rejects with a TimeoutError when the source never settles', async () => {
    vi.useFakeTimers();
    try {
      const p = withTimeout(new Promise<never>(() => {}), 50);
      const assertion = expect(p).rejects.toBeInstanceOf(TimeoutError);
      await vi.advanceTimersByTimeAsync(51);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
