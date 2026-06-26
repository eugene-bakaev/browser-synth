import { readRoomIdFromUrl } from './roomId';

// Bring the app's session + view into agreement with whatever room the address
// bar currently names. Called on browser history navigation (back/forward) and
// on bfcache restores — the cases the one-shot onMounted boot does NOT cover,
// because the memory-history router never reacts to the URL and nothing else
// re-derives the room after the initial document load.
export interface ReconcileDeps {
  // The room the app is currently connected to (synth.currentRoomId), or null.
  currentRoomId: string | null;
  // Enter / switch to a room. `force` rebuilds the connection even when it is
  // already the current room (used after a bfcache restore, whose frozen socket
  // is dead). Reflects the room in the URL via replaceState — never pushes, so
  // reconciling the URL we are already sitting on can't corrupt history.
  connect: (roomId: string, opts?: { force?: boolean }) => void;
  // Leave the current room (drops the connection, resets the project).
  leave: () => void;
  // Switch the in-app (memory-history) view.
  showStudio: () => void;
  showLobby: () => void;
  // True when reconciling a bfcache page restore: the previously-live socket was
  // closed while the page was frozen, so a URL that still matches currentRoomId
  // must nonetheless be force-reconnected to become live again.
  bfcacheRestore?: boolean;
  // Injectable URL reader (tests).
  readRoom?: () => string | null;
}

export function reconcileSessionToUrl(deps: ReconcileDeps): void {
  const urlRoom = (deps.readRoom ?? readRoomIdFromUrl)();
  if (urlRoom) {
    if (urlRoom !== deps.currentRoomId) {
      deps.connect(urlRoom);
    } else if (deps.bfcacheRestore) {
      deps.connect(urlRoom, { force: true });
    }
    deps.showStudio();
  } else {
    if (deps.currentRoomId !== null) deps.leave();
    deps.showLobby();
  }
}
