import { describe, it, expect, vi } from 'vitest';
import { reconcileSessionToUrl, type ReconcileDeps } from './reconcileSession';

// Build a deps object whose connect/leave/showStudio/showLobby are spies, with
// the URL room and the app's current room injected directly.
function makeDeps(
  over: Partial<ReconcileDeps> & {
    urlRoom: string | null;
    currentRoomId: string | null;
    urlTrack?: number | null;
  },
): ReconcileDeps & {
  connect: ReturnType<typeof vi.fn>;
  leave: ReturnType<typeof vi.fn>;
  showStudio: ReturnType<typeof vi.fn>;
  showLobby: ReturnType<typeof vi.fn>;
  applyView: ReturnType<typeof vi.fn>;
  readTrack: ReturnType<typeof vi.fn>;
} {
  return {
    currentRoomId: over.currentRoomId,
    connect: vi.fn(),
    leave: vi.fn(),
    showStudio: vi.fn(),
    showLobby: vi.fn(),
    applyView: vi.fn(),
    bfcacheRestore: over.bfcacheRestore,
    readRoom: () => over.urlRoom,
    readTrack: vi.fn(() => over.urlTrack ?? null),
  } as never;
}

describe('reconcileSessionToUrl', () => {
  it('connects to the URL room and shows studio when the URL points at a different room', () => {
    const deps = makeDeps({ urlRoom: 'roomb1', currentRoomId: 'rooma1' });
    reconcileSessionToUrl(deps);
    expect(deps.connect).toHaveBeenCalledWith('roomb1');
    expect(deps.showStudio).toHaveBeenCalledTimes(1);
    expect(deps.leave).not.toHaveBeenCalled();
    expect(deps.showLobby).not.toHaveBeenCalled();
  });

  it('connects when the URL has a room but the app is not in any session (deep-link / forward-to-room)', () => {
    const deps = makeDeps({ urlRoom: 'rooma1', currentRoomId: null });
    reconcileSessionToUrl(deps);
    expect(deps.connect).toHaveBeenCalledWith('rooma1');
    expect(deps.showStudio).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect when already in the URL room (live same-room popstate)', () => {
    const deps = makeDeps({ urlRoom: 'rooma1', currentRoomId: 'rooma1' });
    reconcileSessionToUrl(deps);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.showStudio).toHaveBeenCalledTimes(1);
  });

  it('force-reconnects to the same room on a bfcache restore (the socket died while frozen)', () => {
    const deps = makeDeps({ urlRoom: 'rooma1', currentRoomId: 'rooma1', bfcacheRestore: true });
    reconcileSessionToUrl(deps);
    expect(deps.connect).toHaveBeenCalledWith('rooma1', { force: true });
    expect(deps.showStudio).toHaveBeenCalledTimes(1);
    expect(deps.leave).not.toHaveBeenCalled();
  });

  it('leaves the session and shows the lobby when the URL has no room', () => {
    const deps = makeDeps({ urlRoom: null, currentRoomId: 'rooma1' });
    reconcileSessionToUrl(deps);
    expect(deps.leave).toHaveBeenCalledTimes(1);
    expect(deps.showLobby).toHaveBeenCalledTimes(1);
    expect(deps.connect).not.toHaveBeenCalled();
    expect(deps.showStudio).not.toHaveBeenCalled();
  });

  it('just shows the lobby (no leave) when the URL has no room and the app is already roomless', () => {
    const deps = makeDeps({ urlRoom: null, currentRoomId: null });
    reconcileSessionToUrl(deps);
    expect(deps.leave).not.toHaveBeenCalled();
    expect(deps.showLobby).toHaveBeenCalledTimes(1);
  });

  // --- Focused-track view reconciliation (?t in the URL) ---

  it('applies the focused track from the URL when a room is present (same-room Back/Forward derive)', () => {
    const deps = makeDeps({ urlRoom: 'rooma1', currentRoomId: 'rooma1', urlTrack: 3 });
    reconcileSessionToUrl(deps);
    expect(deps.applyView).toHaveBeenCalledWith(3);
  });

  it('applies the overview (null track) when the room URL has no ?t', () => {
    const deps = makeDeps({ urlRoom: 'rooma1', currentRoomId: 'rooma1', urlTrack: null });
    reconcileSessionToUrl(deps);
    expect(deps.applyView).toHaveBeenCalledWith(null);
  });

  it('reads the focused track BEFORE connect (which rewrites the URL and would drop a deep-linked ?t)', () => {
    const deps = makeDeps({ urlRoom: 'roomb1', currentRoomId: 'rooma1', urlTrack: 2 });
    reconcileSessionToUrl(deps);
    // Deep-link / room-switch: connect rebuilds /r/<id> and strips ?t, so the
    // track must be captured first and re-applied after.
    expect(deps.readTrack.mock.invocationCallOrder[0]).toBeLessThan(
      deps.connect.mock.invocationCallOrder[0],
    );
    expect(deps.applyView).toHaveBeenCalledWith(2);
  });

  it('does not touch the focused-track view in the lobby branch (no room)', () => {
    const deps = makeDeps({ urlRoom: null, currentRoomId: 'rooma1' });
    reconcileSessionToUrl(deps);
    expect(deps.applyView).not.toHaveBeenCalled();
  });
});
