import { ref, computed, toRaw, type InjectionKey } from 'vue';
import type { OscillatorTypeLiteral, Path } from '@fiddle/shared';
import { getDeep, TRACK_POOL_SIZE, moveTrackBefore, ordersEqual } from '@fiddle/shared';
import { type EngineType, freshProject, freshTrack } from '../project';
import { setRoomInUrl, clearRoomFromUrl, setFocusedTrackInUrl } from '../sync/roomId';
import { roster, selfClientId } from '../sync/presence';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';
import { createProjectOps } from './projectOps';
import type { AppRuntime } from './AppRuntime';

export type SynthContext = ReturnType<typeof createSynthContext>;
// Symbol.for (not Symbol()) is HMR-stable: a hot-swapped module re-creates a
// plain Symbol, which would break provide/inject pairing across the swap.
export const SYNTH_CONTEXT: InjectionKey<SynthContext> = Symbol.for('fiddle:synthContext');

// createSynthContext — builds the injected facade the component tree consumes.
// Called EXACTLY ONCE, by App.vue (the never-unmounting shell), with the
// page's AppRuntime. Everything stateful in here (activeTrackIndex,
// sessionName) is per-context — i.e. per page — replacing useSynth's per-call
// refs and module-scope singletons.
export function createSynthContext(runtime: AppRuntime) {
  const { bus, session, audio } = runtime;
  const project = runtime.store.project;

  const activeTrackIndex = ref<number | null>(null); // null means the track overview

  // The current room's display name, loaded by the App shell from getSession()
  // whenever currentRoomId changes. null = not loaded / no room; '' = loaded but
  // untitled. Rendered (static) in the top app-bar; updated after a local rename.
  // App-shell-owned, not part of the SyncSession.
  const sessionName = ref<string | null>(null);

  // The single outbound entry point for a LOCAL edit. Always routes through the
  // command bus: the bus writes state + emits to the audio stream; the outbound
  // enqueue is gated on the room being live inside session.enqueue, so
  // pre-connect edits still drive audio + UI without trying to sync.
  function dispatchLocal(path: Path, value: unknown, gestureEndOverride?: boolean): void {
    const gestureEnd = gestureEndOverride ?? gestureEndForLeaf(String(path[path.length - 1]));
    const prior = getDeep(project as unknown as Record<string, unknown>, path);
    // toRaw: object leaves (trackOrder, a whole track) must be captured raw so
    // undo's identity/deepEqual comparisons (see AppRuntime getLiveValue) hold.
    const priorValue = typeof prior === 'object' && prior !== null ? toRaw(prior) : prior;
    bus.dispatchLocal({ path, value, priorValue, gestureEnd });
  }

  // Flush the outbox entry for `path` immediately — called from a knob's
  // gesture-end (mouseup) so the final drag value goes out without waiting out
  // the 50ms throttle. No-op when sync is off or nothing is pending. Used by the
  // panels via useKnobSync (see sync/knobSync.ts).
  function endGesture(path: Path): void {
    runtime.history.endGesture(path); // close the undo drag-merge window for this knob
    session.flushPath(path);
  }

  // Bulk project operations (Clear/Shift/Fill, preset load, INIT PATCH, New/Open)
  // as pure draft-diff-dispatch through the bus. Per-context (per page).
  const projectOps = createProjectOps({
    project,
    bus,
    isSyncLive: () => session.isSyncLive,
    enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
    canBulkLoad: () => session.canBulkLoad,
    sendLoad: (next, prior) => session.sendProjectLoad(next, prior),
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
  function connectToSession(
    roomId: string,
    opts?: { history?: 'push' | 'replace'; force?: boolean },
  ): void {
    // A no-op re-connect to the room we're already in must never PUSH a second
    // /r/<id> entry — force 'replace' in that case, whatever the caller asked for.
    const alreadyHere = !opts?.force && session.isConnected && session.currentRoomId.value === roomId;
    setRoomInUrl(roomId, alreadyHere ? 'replace' : (opts?.history ?? 'replace'));
    // Entering a session always opens the overview: the new room's URL carries no
    // `?t`, so resetting the focused-track ref here keeps the view in step with the
    // URL and stops a stale editor from the previous session bleeding into the next.
    activeTrackIndex.value = null;
    // Test mode (sync disabled): reflect the room without opening a socket; no reset.
    if (!session.isSyncEnabled) { session.connect(roomId); return; }
    if (alreadyHere) return;
    // Close the previous room's socket first, then blank the store, then build the
    // new socket — order matters so no remote op applies onto the fresh project and
    // no stale content is synced up into the new room before its snapshot arrives.
    if (session.isConnected) session.disconnect();
    bus.loadProject(freshProject());
    session.connect(roomId);
  }

  // Leave the current session: drop the connection, reset local state to a neutral
  // project, clear the room from the URL, and drop back to the overview. Audio
  // stays alive.
  function leaveSession(): void {
    session.disconnect();
    bus.loadProject(freshProject());
    clearRoomFromUrl();
    activeTrackIndex.value = null;
  }

  const waveforms: OscillatorTypeLiteral[] = ['sine', 'square', 'sawtooth', 'triangle'];

  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { dispatchLocal(['bpm'], v); },
  });

  // The currently-focused track, or null on the track overview. Panels read
  // their reactive engine slice from this (e.g. focusedTrack.value.engines.synth)
  // for display; writes route through the command bus (dispatchLocal), not direct
  // mutation. Audio reacts via the bus's applied-command stream, not by watching
  // this slice (the watchers are gone). Replaces the per-param trackParam refs
  // that previously projected each field individually.
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
  // any) AND move that slot to the end of the display order (new tracks always
  // appear last — spec 2026-07-15-track-reorder-design). Both dispatches share
  // one synchronous task, so the undo burst rule makes them ONE undo entry.
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx === -1) return;
    // Overwrite the reused slot with a fresh, ENABLED track in ONE atomic op.
    // freshTrack(true).enabled === true, so this enables AND clears together:
    // a per-leaf reset would op-storm past the rate limiter, and a bare
    // enabled=true would resurrect the deleted track's content. gestureEnd=true
    // (discrete action → flush immediately). dispatchLocal captures the prior
    // (the deleted track) for nack rollback + undo. Both dispatches share one
    // synchronous task → ONE undo entry (burst rule).
    dispatchLocal(['tracks', idx], freshTrack(true), true);
    const next = moveTrackBefore(project.trackOrder, idx, null);
    if (!ordersEqual(next, project.trackOrder)) dispatchLocal(['trackOrder'], next);
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
    project,                                       // single source of truth
    sequencer: audio.sequencer,
    bpm,                                           // writable computed against project.bpm
    trackAnalysers: audio.trackAnalysers,
    trackGains: audio.trackGains,
    activeTrackIndex,
    focusedTrack,
    currentStep: audio.currentStep,
    waveforms,
    shortestActiveNoteDuration,
    togglePlay: audio.togglePlay,
    stopPlayback: audio.stopPlayback,
    selectTrack,
    setFocusedTrack,
    getTrackEngineType,
    enabledTrackCount,
    addTrack,
    removeTrack,
    // Force audio init without playing — needed by tests and any consumer
    // that needs the audio graph up before the first togglePlay.
    ensureAudio: audio.ensureAudio,
    // --- Sync surface (read by Sidebar / AccountView / ErrorOverlay) ---
    fatalError: session.fatalError,       // ref<{code,message}|null> — set on a fatal server error
    roomLoading: session.roomLoading,     // ref<boolean> — true while the room's initial catch-up runs
    loadError: session.loadError,         // ref<string|null> — set on a terminal bulk-load failure
    roster,           // ref<Identity[]> — everyone in the room
    selfClientId,     // ref<string|null> — which roster entry is us
    currentRoomId: session.currentRoomId,
    sessionName,
    connectToSession,
    leaveSession,
    // --- Phase 5 additions to the facade (were module-scope in useSynth) ---
    dispatchLocal,
    endGesture,
    projectOps,
    keyboard: runtime.keyboard,
  };
}
