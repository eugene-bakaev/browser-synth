import { describe, it, expect, vi, afterEach } from 'vitest';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import {
  readRoomIdFromUrl,
  resolveInitialView,
  setRoomInUrl,
  readFocusedTrackFromUrl,
  setFocusedTrackInUrl,
} from './roomId';

describe('readRoomIdFromUrl', () => {
  it('extracts the room id from /r/<id>', () => {
    expect(readRoomIdFromUrl({ pathname: '/r/j7k2mq8n3' } as Location)).toBe('j7k2mq8n3');
  });

  it('matches case-insensitively and normalizes to lowercase', () => {
    expect(readRoomIdFromUrl({ pathname: '/r/J7K2MQ8N3' } as Location)).toBe('j7k2mq8n3');
  });

  it('returns null when the URL has no room (no auto-mint)', () => {
    expect(readRoomIdFromUrl({ pathname: '/' } as Location)).toBeNull();
    expect(readRoomIdFromUrl({ pathname: '/lobby' } as Location)).toBeNull();
  });
});

describe('resolveInitialView', () => {
  it('is studio when a room is present, lobby otherwise', () => {
    expect(resolveInitialView({ pathname: '/r/j7k2mq8n3' } as Location)).toBe('studio');
    expect(resolveInitialView({ pathname: '/' } as Location)).toBe('lobby');
  });
});

describe('setRoomInUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('replaces the current history entry by default (deep-link / reconciliation — no new entry)', () => {
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { replaceState, pushState } });
    setRoomInUrl('j7k2mq8n3');
    expect(replaceState).toHaveBeenCalledWith(null, '', '/r/j7k2mq8n3');
    expect(pushState).not.toHaveBeenCalled();
  });

  it("pushes a new history entry in 'push' mode (lobby join — so Back returns to the lobby)", () => {
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { replaceState, pushState } });
    setRoomInUrl('j7k2mq8n3', 'push');
    expect(pushState).toHaveBeenCalledWith(null, '', '/r/j7k2mq8n3');
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('readFocusedTrackFromUrl', () => {
  const loc = (search: string) => ({ search } as Location);

  it('reads the focused-track index from the ?t query param', () => {
    expect(readFocusedTrackFromUrl(loc('?t=2'))).toBe(2);
    expect(readFocusedTrackFromUrl(loc('?t=0'))).toBe(0);
  });

  it('finds ?t alongside other query params', () => {
    expect(readFocusedTrackFromUrl(loc('?foo=bar&t=3'))).toBe(3);
  });

  it('returns null when there is no ?t param (overview)', () => {
    expect(readFocusedTrackFromUrl(loc(''))).toBeNull();
    expect(readFocusedTrackFromUrl(loc('?foo=bar'))).toBeNull();
  });

  it('accepts the last valid pool index but rejects one past it', () => {
    expect(readFocusedTrackFromUrl(loc(`?t=${TRACK_POOL_SIZE - 1}`))).toBe(TRACK_POOL_SIZE - 1);
    expect(readFocusedTrackFromUrl(loc(`?t=${TRACK_POOL_SIZE}`))).toBeNull();
  });

  it('rejects non-integer, negative, and non-numeric values (→ overview)', () => {
    expect(readFocusedTrackFromUrl(loc('?t=-1'))).toBeNull();
    expect(readFocusedTrackFromUrl(loc('?t=2.5'))).toBeNull();
    expect(readFocusedTrackFromUrl(loc('?t=abc'))).toBeNull();
    expect(readFocusedTrackFromUrl(loc('?t='))).toBeNull();
  });
});

describe('setFocusedTrackInUrl', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('replaces with /r/<room>?t=<index> by default (popstate-driven view sync — no new entry)', () => {
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { replaceState, pushState } });
    setFocusedTrackInUrl('room1a', 2);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/r/room1a?t=2');
    expect(pushState).not.toHaveBeenCalled();
  });

  it("pushes a new entry in 'push' mode (entering the editor — so Back returns to the overview)", () => {
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { replaceState, pushState } });
    setFocusedTrackInUrl('room1a', 2, 'push');
    expect(pushState).toHaveBeenCalledWith(null, '', '/r/room1a?t=2');
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('drops the ?t param (bare room URL) when index is null (leaving the editor)', () => {
    const replaceState = vi.fn();
    const pushState = vi.fn();
    vi.stubGlobal('window', { history: { replaceState, pushState } });
    setFocusedTrackInUrl('room1a', null);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/r/room1a');
    expect(pushState).not.toHaveBeenCalled();
  });
});
