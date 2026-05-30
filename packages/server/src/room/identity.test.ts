import { describe, it, expect } from 'vitest';
import { PALETTE, HANDLES } from '@fiddle/shared';
import type { Identity } from '@fiddle/shared';
import {
  assignColor,
  assignHandle,
  generateClientId,
  makeIdentity,
  makeAuthenticatedIdentity,
} from './identity.js';

describe('assignColor', () => {
  it('picks the first unused PALETTE entry', () => {
    expect(assignColor(new Set())).toBe(PALETTE[0]);
    expect(assignColor(new Set([PALETTE[0]]))).toBe(PALETTE[1]);
  });
});

describe('assignHandle', () => {
  it('picks the first unused HANDLES entry', () => {
    expect(assignHandle(new Set())).toBe(HANDLES[0]);
    expect(assignHandle(new Set([HANDLES[0]]))).toBe(HANDLES[1]);
  });

  it('appends a digit suffix when all base handles are taken', () => {
    const taken = new Set<string>(HANDLES);
    const result = assignHandle(taken);
    expect(result).toMatch(/[A-Za-z]+2$/);
  });
});

describe('generateClientId', () => {
  it('produces 100 unique ids in a row', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) ids.add(generateClientId());
    expect(ids.size).toBe(100);
  });
});

describe('makeIdentity', () => {
  it('skips colors and handles already in the roster', () => {
    const existing: Identity[] = [
      { clientId: 'c_aaaaaaa', color: PALETTE[0], handle: HANDLES[0] },
      { clientId: 'c_bbbbbbb', color: PALETTE[1], handle: HANDLES[1] },
    ];
    const next = makeIdentity(existing);
    expect(next.color).toBe(PALETTE[2]);
    expect(next.handle).toBe(HANDLES[2]);
  });
});

describe('makeAuthenticatedIdentity', () => {
  it('uses the supplied handle + userId and marks authenticated', () => {
    const id = makeAuthenticatedIdentity([], { userId: 'user-9', handle: 'DJ Eugene' });
    expect(id.handle).toBe('DJ Eugene');
    expect(id.userId).toBe('user-9');
    expect(id.authenticated).toBe(true);
    expect(id.clientId).toMatch(/^c_/);
  });

  it('assigns a color not already taken by present peers', () => {
    const present = [
      { clientId: 'c_a', color: PALETTE[0], handle: 'Owl' },
      { clientId: 'c_b', color: PALETTE[1], handle: 'Fox' },
    ];
    const id = makeAuthenticatedIdentity(present, { userId: 'u', handle: 'Name' });
    expect(id.color).not.toBe(PALETTE[0]);
    expect(id.color).not.toBe(PALETTE[1]);
  });
});
