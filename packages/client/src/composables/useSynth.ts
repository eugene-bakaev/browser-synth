import { ref, computed } from 'vue';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import { AudioEngine } from '../audio/AudioEngine';
import {
  type EngineType,
  freshProject,
  replaceProject,
} from '../project';
import { project } from '../stores/project';

// --- Sync layer (WebSocket collaboration) ---
import { WsClient, type WsClientOptions } from '../sync/WsClient';
import { setDeep, getDeep, TRACK_POOL_SIZE } from '@fiddle/shared';
import { setRoomInUrl, clearRoomFromUrl, setFocusedTrackInUrl } from '../sync/roomId';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';
import type { Path } from '@fiddle/shared';
import { SyncSession } from '../sync/SyncSession';
import { createCommandBus } from '../sync/CommandBus';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';
import { createProjectOps } from '../app/projectOps';

// === Pure data state — fresh at module init. ===
//
// The app is session-only: connectToSession resets this to fresh before the
// room snapshot replaces it, so nothing ever rendered a locally-persisted
// project. The old localStorage load/autosave path was removed (review S1) —
// file save/open (file-io.ts) is the offline persistence story.

// The current room's display name, loaded by the App shell from getSession()
// whenever currentRoomId changes. null = not loaded / no room; '' = loaded but
// untitled. Rendered (static) in the top app-bar; updated after a local rename.
// App-shell-owned, not part of the SyncSession.
const sessionName = ref<string | null>(null);

// Flush the outbox entry for `path` immediately — called from a knob's
// gesture-end (mouseup) so the final drag value goes out without waiting out
// the 50ms throttle. No-op when sync is off or nothing is pending. Used by the
// panels via useKnobSync (see sync/knobSync.ts).
export function endGesture(path: Path): void {
  session.flushPath(path);
}

// The single outbound entry point for a LOCAL edit. Always routes through the
// command bus: the bus writes state + emits to the audio stream; the outbound
// enqueue is gated on the room being live inside session.enqueue, so
// pre-connect edits still drive audio + UI without trying to sync.
export function dispatchLocal(path: Path, value: unknown): void {
  const gestureEnd = gestureEndForLeaf(String(path[path.length - 1]));
  const priorValue = getDeep(project as unknown as Record<string, unknown>, path);
  bus.dispatchLocal({ path, value, priorValue, gestureEnd });
}

// Tests flip this off so ensureAudio() doesn't open a real socket; production
// leaves it on. Kept here (not a build-time const) so a test can toggle it on
// the freshly-imported module instance.
let syncEnabled = true;
export function setSyncEnabled(v: boolean): void { syncEnabled = v; }

// Injectable so tests can hand back a WsClient wired to a MockWebSocket +
// in-memory storage instead of touching the network. Production uses the
// default real constructor.
type WsClientFactory = (opts: WsClientOptions) => WsClient;
let wsClientFactory: WsClientFactory = (opts) => new WsClient(opts);
export function setWsClientFactory(f: WsClientFactory | null): void {
  wsClientFactory = f ?? ((opts) => new WsClient(opts));
}

// The one command bus for this tab — THE single gateway to project state.
// Long-lived (survives room switches; SyncSession resets its watermark per
// connect). applySet/loadProject write the canonical project; enqueue hands
// outbound ops to the session, which gates on the room being live.
const bus = createCommandBus({
  applySet: (path, value) => {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  },
  loadProject: (next) => {
    replaceProject(project, next);
  },
  enqueue: (path, value, priorValue, gestureEnd) => {
    session.enqueue(path, value, priorValue, gestureEnd);
  },
});

// The one room connection for this tab. Long-lived; connect/disconnect cycle the
// socket internally, dispose() is the page-unload teardown. Owns WsClient/Outbox
// + presence + the reactive connection state (currentRoomId/roomLoading/
// fatalError), re-exported below so consumers are untouched. Constructed eagerly
// and side-effect-free (no socket, no listeners) so a lobby read of currentRoomId
// works before the first connect.
const session = new SyncSession({
  bus,
  wsClientFactory: () => wsClientFactory,
  syncEnabled: () => syncEnabled,
  auth: () => useAuth(),
});

// The one audio engine for this tab. Long-lived; the AudioContext + engines boot
// lazily on first ensureAudio()/togglePlay(), dispose() is the page-unload
// teardown. Owns ctx/engines/gains/analysers/Sequencer + the transport
// (currentStep), re-exported below so consumers are untouched. Constructed
// eagerly and side-effect-free (no AudioContext until first play).
const audioEngine = new AudioEngine({ project });

// Bulk project operations (Clear/Shift/Fill, preset load, INIT PATCH, New/Open)
// as pure draft-diff-dispatch through the bus. Interim module-scope instance —
// Phase 5 Task 4 moves this onto the synth context.
export const projectOps = createProjectOps({
  project,
  bus,
  isSyncLive: () => session.isSyncLive,
  enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
});

// Enter a session: bring up the room connection for `roomId` and reflect it in
// the URL. Idempotent for the same room; switches cleanly between rooms. Does
// NOT touch audio — the AudioContext still boots lazily on first PLAY.
//
// `history` controls how the URL change is recorded: 'replace' (default) keeps a
// single entry; the lobby passes 'push' so Back returns to the lobby. `force`
// rebuilds the connection even when it is already the current room — used after a
// bfcache restore, whose frozen socket is dead, where the idempotent same-room
// short-circuit would otherwise leave the page disconnected.
export function connectToSession(
  roomId: string,
  opts?: { history?: 'push' | 'replace'; force?: boolean },
): void {
  // A no-op re-connect to the room we're already in must never PUSH a second
  // /r/<id> entry — force 'replace' in that case, whatever the caller asked for.
  const alreadyHere = !opts?.force && session.isConnected && session.currentRoomId.value === roomId;
  setRoomInUrl(roomId, alreadyHere ? 'replace' : (opts?.history ?? 'replace'));
  // Test mode (sync disabled): reflect the room without opening a socket; no reset.
  if (!syncEnabled) { session.connect(roomId); return; }
  if (alreadyHere) return;
  // Close the previous room's socket first, then blank the store, then build the
  // new socket — order matters so no remote op applies onto the fresh project and
  // no stale content is synced up into the new room before its snapshot arrives.
  if (session.isConnected) session.disconnect();
  resetLocalProject();
  session.connect(roomId);
}

// Reset local project state to a neutral fresh project. Shared by leaveSession
// and connectToSession; only safe to call while the session is disconnected —
// both callers run session.disconnect() first — otherwise the outbound emitters
// would sync the blanking up into the room as local edits.
function resetLocalProject(): void {
  bus.loadProject(freshProject());
}

// Leave the current session: drop the connection, reset local state to a neutral
// project, and clear the room from the URL. Audio stays alive.
export function leaveSession(): void {
  session.disconnect();
  resetLocalProject();
  clearRoomFromUrl();
}

// Exposed primarily for tests; production code does not call this. Tears down
// the audio engine (ctx/engines/transport) then the sync layer so a re-init
// (or a test) starts clean.
export function disposeSynth() {
  audioEngine.dispose();
  session.dispose();
}

export function useSynth() {
  const activeTrackIndex = ref<number | null>(null); // null means the track overview

  const waveforms: OscillatorTypeLiteral[] = ['sine', 'square', 'sawtooth', 'triangle'];

  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { dispatchLocal(['bpm'], v); },
  });

  // The currently-focused track, or null on the track overview. Panels read
  // their reactive engine slice from this (e.g. focusedTrack.value.engines.synth)
  // for display; writes route through the command bus (dispatchLocal), not direct
  // mutation. The live slice still drives the audio-reaction watcher. Replaces the
  // per-param trackParam refs that previously projected each field individually.
  const focusedTrack = computed(() =>
    activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value] : null
  );

  const shortestActiveNoteDuration = computed<number | null>(() => {
    if (activeTrackIndex.value === null) return null;
    const track = project.tracks[activeTrackIndex.value];
    if (!track) return null;
    // Only the active window contributes — steps beyond patternLength don't play.
    const activeSteps = track.steps
      .slice(0, track.patternLength)
      .filter(s => s.note !== null && !s.muted);
    if (activeSteps.length === 0) return null;
    const tickDuration = (60 / project.bpm) / 4;
    const minTicks = Math.min(...activeSteps.map(s => s.length));
    return minTicks * tickDuration;
  });

  // The focused-track view (overview vs. single-track editor) is URL-driven: the
  // address bar's `?t=<index>` is the source of truth, so every history nav
  // re-derives the view and a stale editor can't bleed across sessions. This
  // writes both the URL and the local ref in lockstep.
  const applyFocusedTrack = (index: number | null, mode: 'push' | 'replace') => {
    const room = session.currentRoomId.value;
    if (room) setFocusedTrackInUrl(room, index, mode);
    activeTrackIndex.value = index;
  };

  // User action (overview cell → editor, or BACK TO OVERVIEW). Opening the editor
  // PUSHES a history entry so browser Back returns to the overview (then to the
  // lobby); leaving it REPLACES, dropping `?t` without growing history.
  const selectTrack = (index: number | null) =>
    applyFocusedTrack(index, index === null ? 'replace' : 'push');

  // Reconcile the view from the URL on a history navigation (popstate / bfcache /
  // deep-link). Always REPLACE — a Back/Forward must not mint new entries — and
  // re-assert `?t` because connect() may have stripped it rebuilding the room URL.
  const setFocusedTrack = (index: number | null) => applyFocusedTrack(index, 'replace');

  const getTrackEngineType = (index: number): EngineType => {
    return project.tracks[index].engineType;
  };

  // How many of the fixed 32-slot pool are currently enabled (= "the track
  // count" the UI shows).
  const enabledTrackCount = computed(() => project.tracks.filter(t => t.enabled).length);

  // Add a track = enable the lowest-index disabled slot (fills a freed hole if
  // any). No-op when the pool is full.
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx !== -1) dispatchLocal(['tracks', idx, 'enabled'], true);
  };

  // Remove a track = disable that slot (non-destructive; step/param data stays
  // so re-adding restores it). Refused when it would leave zero enabled tracks.
  const removeTrack = (index: number): void => {
    if (index < 0 || index >= TRACK_POOL_SIZE) return;
    if (!project.tracks[index].enabled) return;
    if (enabledTrackCount.value <= 1) return;
    dispatchLocal(['tracks', index, 'enabled'], false);
  };

  return {
    project,                                       // NEW: single source of truth
    sequencer: audioEngine.sequencer,
    bpm,                                           // NEW: writable computed against project.bpm
    trackAnalysers: audioEngine.trackAnalysers,
    trackGains: audioEngine.trackGains,
    activeTrackIndex,
    focusedTrack,
    currentStep: audioEngine.currentStep,
    waveforms,
    shortestActiveNoteDuration,
    togglePlay: audioEngine.togglePlay,
    stopPlayback: audioEngine.stopPlayback,
    selectTrack,
    setFocusedTrack,
    getTrackEngineType,
    enabledTrackCount,
    addTrack,
    removeTrack,
    // Force audio init without playing — needed by tests and any consumer
    // that needs the audio graph up before the first togglePlay.
    ensureAudio: audioEngine.ensureAudio,
    // --- Sync surface (read by Sidebar / AccountView / ErrorOverlay) ---
    fatalError: session.fatalError,       // ref<{code,message}|null> — set on a fatal server error
    roomLoading: session.roomLoading,     // ref<boolean> — true while the room's initial catch-up runs
    roster,           // ref<Identity[]> — everyone in the room
    selfClientId,     // ref<string|null> — which roster entry is us
    currentRoomId: session.currentRoomId,
    sessionName,
    // Entering or leaving a session always opens the overview: the new room's URL
    // carries no `?t`, so resetting the focused-track ref here keeps the view in
    // step with the URL and stops a stale editor from the previous session
    // bleeding into the next one. (Deep-links re-apply `?t` via setFocusedTrack
    // in the URL-reconcile path.)
    connectToSession: (roomId: string, opts?: { history?: 'push' | 'replace'; force?: boolean }) => {
      connectToSession(roomId, opts);
      activeTrackIndex.value = null;
    },
    leaveSession: () => {
      leaveSession();
      activeTrackIndex.value = null;
    },
  };
}
