import { describe, it, expect } from 'vitest';
import { frameType, recordWsFrame } from './ws.js';

describe('frameType', () => {
  it('extracts the type field from a parsed frame', () => {
    expect(frameType({ type: 'set', path: ['bpm'] })).toBe('set');
  });
  it('returns "unknown" for null / typeless / non-object / non-string-type frames', () => {
    expect(frameType(null)).toBe('unknown');
    expect(frameType({})).toBe('unknown');
    expect(frameType(42)).toBe('unknown');
    expect(frameType({ type: 42 })).toBe('unknown'); // type present but not a string
  });
});

describe('recordWsFrame', () => {
  it('does not throw without an OTel provider', () => {
    expect(() => recordWsFrame('in', 'set', 128)).not.toThrow();
    expect(() => recordWsFrame('out', 'snapshot', 224000)).not.toThrow();
  });
});
