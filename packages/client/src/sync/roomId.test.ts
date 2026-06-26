import { describe, it, expect, vi, afterEach } from 'vitest';
import { readRoomIdFromUrl, resolveInitialView, setRoomInUrl } from './roomId';

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
