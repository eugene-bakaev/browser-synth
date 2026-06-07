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
});
