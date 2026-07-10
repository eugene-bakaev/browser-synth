import { describe, it, expect } from 'vitest';
import { parseBinding, matchesEvent, sameDescriptor, detectPlatform } from './keys';

// Minimal event stub — matchesEvent only reads these five fields.
function ev(key: string, mods: Partial<{ meta: boolean; ctrl: boolean; shift: boolean; alt: boolean }> = {}) {
  return {
    key,
    metaKey: mods.meta ?? false,
    ctrlKey: mods.ctrl ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
  };
}

describe('parseBinding', () => {
  it('parses a bare key', () => {
    expect(parseBinding('escape')).toEqual({ key: 'escape', mod: false, shift: false, alt: false });
  });
  it('parses modifiers in any order and lowercases', () => {
    expect(parseBinding('Shift+Mod+C')).toEqual({ key: 'c', mod: true, shift: true, alt: false });
  });
  it('maps the space alias to the literal space key', () => {
    expect(parseBinding('space').key).toBe(' ');
  });
  it('throws on an unknown modifier', () => {
    expect(() => parseBinding('hyper+c')).toThrow(/unknown modifier/i);
  });
  it('throws on an empty key', () => {
    expect(() => parseBinding('mod+')).toThrow(/invalid/i);
  });
});

describe('matchesEvent', () => {
  const modC = parseBinding('mod+c');
  it('mod resolves to metaKey on mac', () => {
    expect(matchesEvent(modC, ev('c', { meta: true }), 'mac')).toBe(true);
    expect(matchesEvent(modC, ev('c', { ctrl: true }), 'mac')).toBe(false);
  });
  it('mod resolves to ctrlKey elsewhere', () => {
    expect(matchesEvent(modC, ev('c', { ctrl: true }), 'other')).toBe(true);
    expect(matchesEvent(modC, ev('c', { meta: true }), 'other')).toBe(false);
  });
  it('is strict: mod+c does not fire on mod+shift+c', () => {
    expect(matchesEvent(modC, ev('C', { meta: true, shift: true }), 'mac')).toBe(false);
  });
  it('is strict: bare arrowup does not fire when shift is held', () => {
    expect(matchesEvent(parseBinding('arrowup'), ev('ArrowUp', { shift: true }), 'mac')).toBe(false);
  });
  it('shift+arrowdown matches (event key is case-normalized)', () => {
    expect(matchesEvent(parseBinding('shift+arrowdown'), ev('ArrowDown', { shift: true }), 'other')).toBe(true);
  });
  it('shifted letters match by lowercased event key', () => {
    expect(matchesEvent(parseBinding('shift+arrowup'), ev('ArrowUp', { shift: true }), 'mac')).toBe(true);
    expect(matchesEvent(parseBinding('mod+shift+z'), ev('Z', { meta: true, shift: true }), 'mac')).toBe(true);
  });
});

describe('sameDescriptor', () => {
  it('equal descriptors compare equal, different keys or mods do not', () => {
    expect(sameDescriptor(parseBinding('mod+c'), parseBinding('Mod+C'))).toBe(true);
    expect(sameDescriptor(parseBinding('mod+c'), parseBinding('mod+x'))).toBe(false);
    expect(sameDescriptor(parseBinding('mod+c'), parseBinding('mod+shift+c'))).toBe(false);
  });
});

describe('detectPlatform', () => {
  it('detects mac from platform or userAgent', () => {
    expect(detectPlatform({ platform: 'MacIntel' })).toBe('mac');
    expect(detectPlatform({ userAgent: 'Mozilla/5.0 (Macintosh; ...)' })).toBe('mac');
    expect(detectPlatform({ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT ...)' })).toBe('other');
  });
});
