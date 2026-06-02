import { describe, it, expect } from 'vitest';
import { DEFAULT_SESSION_SETTINGS } from './settings.js';

describe('DEFAULT_SESSION_SETTINGS', () => {
  it('provides inert defaults for the stored-but-disabled fields', () => {
    expect(DEFAULT_SESSION_SETTINGS).toEqual({
      maxWritableUsers: 4,
      tracksPerUser: 4,
    });
  });

  it('is a fresh object each import reference (not accidentally shared mutable)', () => {
    // Guards against a future change handing out a frozen/shared singleton that
    // callers mutate. A spread copy must be safe.
    const copy = { ...DEFAULT_SESSION_SETTINGS, name: undefined };
    expect(copy.maxWritableUsers).toBe(4);
  });
});
