import { describe, it, expect } from 'vitest';
import { resolveCorsOrigin } from './cors.js';

describe('resolveCorsOrigin', () => {
  it('reflects any origin when CORS_ORIGIN is unset', () => {
    expect(resolveCorsOrigin(undefined)).toBe(true);
  });

  it('reflects any origin for an empty / whitespace value', () => {
    expect(resolveCorsOrigin('')).toBe(true);
    expect(resolveCorsOrigin('   ')).toBe(true);
  });

  it('parses a comma-separated allowlist, trimming entries', () => {
    expect(resolveCorsOrigin('https://a.com, https://b.com')).toEqual([
      'https://a.com',
      'https://b.com',
    ]);
  });

  it('keeps a single origin as a one-element allowlist', () => {
    expect(resolveCorsOrigin('https://fiddle-client.vercel.app')).toEqual([
      'https://fiddle-client.vercel.app',
    ]);
  });
});
