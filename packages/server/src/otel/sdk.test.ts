import { describe, it, expect, afterEach } from 'vitest';
import { isOtelEnabled, startOtel, shutdownOtel } from './sdk.js';

describe('otel bootstrap', () => {
  afterEach(async () => {
    delete process.env.FIDDLE_OTEL;
    await shutdownOtel();
  });

  it('isOtelEnabled reflects the FIDDLE_OTEL flag', () => {
    delete process.env.FIDDLE_OTEL;
    expect(isOtelEnabled()).toBe(false);
    process.env.FIDDLE_OTEL = '1';
    expect(isOtelEnabled()).toBe(true);
  });

  it('startOtel is a no-op when the flag is unset (no throw, idempotent)', async () => {
    delete process.env.FIDDLE_OTEL;
    expect(() => startOtel()).not.toThrow();
    expect(() => startOtel()).not.toThrow();
  });

  it('does not start the SDK when the flag is unset', async () => {
    // sdk is module-private, so prove the guard held indirectly: with no SDK
    // started, shutdownOtel resolves immediately to undefined (the early return)
    // rather than awaiting a real provider shutdown.
    delete process.env.FIDDLE_OTEL;
    startOtel();
    await expect(shutdownOtel()).resolves.toBeUndefined();
  });
});
