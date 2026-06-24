import { ref, reactive, watch, computed, effectScope, shallowRef, type EffectScope, type ComputedRef } from 'vue';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import { Synth2Engine } from '../engine/Synth2Engine';
import { Kick2Engine } from '../engine/Kick2Engine';
import { Snare2Engine } from '../engine/Snare2Engine';
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';
// Worklet asset URL — must be a separate browser asset loaded via
// audioContext.audioWorklet.addModule, not bundled into the main chunk. Vite
// recognizes the `new URL(string-literal, import.meta.url)` pattern and emits
// the file alongside the main bundle with a hashed filename. The processor
// inside registers itself as 'pulse'.
const pulseWorkletUrl = new URL('../engine/worklets/pulse-processor.js', import.meta.url).href;

// synth2 worklet — esbuild-bundled into public/worklets by `build:worklet`
// (a static asset, NOT in Vite's module graph — see client package.json).
const synth2WorkletUrl = '/worklets/synth2-processor.js';

// kick2 worklet — same esbuild-bundled static-asset story as synth2.
const kick2WorkletUrl = '/worklets/kick2-processor.js';

// snare2 worklet — same esbuild-bundled static-asset story as kick2.
const snare2WorkletUrl = '/worklets/snare2-processor.js';

// hat2 worklet — same esbuild-bundled static-asset story as snare2.
const hat2WorkletUrl = '/worklets/hat2-processor.js';

// clap2 worklet — same esbuild-bundled static-asset story as hat2.
const clap2WorkletUrl = '/worklets/clap2-processor.js';

import {
  type Project,
  type ProjectTrack,
  type EngineType,
  freshProject,
  replaceProject,
} from '../project';

// --- Sync layer (WebSocket collaboration) ---
import { WsClient, type WsClientOptions } from '../sync/WsClient';
import { Outbox } from '../sync/Outbox';
import { isApplyingFromNetwork, enterSuppress, exitSuppress, resetApplyOpState } from '../sync/applyOp';
import { setDeep, TRACK_POOL_SIZE } from '@fiddle/shared';
import { setRoomInUrl, clearRoomFromUrl } from '../sync/roomId';
import { dispatchServerMessage } from '../sync/messageDispatch';
import { roster, selfClientId, resetPresence } from '../sync/presence';
import { useAuth } from '../auth/useAuth';
import type { Path } from '@fiddle/shared';

// === Pure data state — fresh at module init. ===
//
// The app is session-only: connectToSession resets this to fresh before the
// room snapshot replaces it, so nothing ever rendered a locally-persisted
// project. The old localStorage load/autosave path was removed (review S1) —
// file save/open (file-io.ts) is the offline persistence story.

const project: Project = reactive(freshProject());

const sequencer = reactive(new Sequencer());

// === Engine factories — unchanged ===
const ENGINE_SWAP_FADE_SECONDS = 0.02;

const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap', 'synth2', 'kick2', 'snare2', 'hat2', 'clap2'];

const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth:  (ctx, dest) => new SynthEngine(ctx, dest),
  kick:   (ctx, dest) => new KickEngine(ctx, dest),
  hat:    (ctx, dest) => new HatEngine(ctx, dest),
  snare:  (ctx, dest) => new SnareEngine(ctx, dest),
  clap:   (ctx, dest) => new ClapEngine(ctx, dest),
  synth2: (ctx, dest) => new Synth2Engine(ctx, dest),
  kick2:  (ctx, dest) => new Kick2Engine(ctx, dest),
  snare2: (ctx, dest) => new Snare2Engine(ctx, dest),
  hat2:   (ctx, dest) => new Hat2Engine(ctx, dest),
  clap2:  (ctx, dest) => new Clap2Engine(ctx, dest),
};

// Mixer volume is stored as slider position 0..1 (perceptual). The actual
// AudioParam.gain needs a linear multiplier — convert via -54..+6 dB then
// 10^(dB/20). Slider at 0 is hard silence (matches muted semantics). The
// matching display formula lives in Knob.vue case 'db' — keep them in sync.
function sliderToLinearGain(slider: number): number {
  if (slider <= 0) return 0;
  const db = -54 + slider * 60;
  return Math.pow(10, db / 20);
}

// JSON-clone: walks string-keyed enumerable props only, skipping the Symbol
// metadata that Vue's reactive proxy attaches. structuredClone fails on
// reactive proxies because it tries to clone the proxy's internal flags.
// Safe here because our params are pure JSON: strings + numbers, no Dates,
// no NaN/Infinity, no functions.
function snapshot<T>(slice: T): T {
  return JSON.parse(JSON.stringify(slice));
}

// Returns the subset of `newVal` keys whose values differ from `oldVal`, or
// null if nothing changed. Used to feed engine.applyParams() the minimum set
// of writes per knob turn instead of the full slice (was 13 writes/knob for
// the synth; now typically 1).
function diffParams<T extends Record<string, unknown>>(
  newVal: T,
  oldVal: T | undefined
): Partial<T> | null {
  if (!oldVal) return null;
  const changed: Partial<T> = {};
  let any = false;
  for (const key of Object.keys(newVal) as Array<keyof T>) {
    const a = newVal[key];
    const b = oldVal[key];
    if (a === b) continue;
    if (typeof a === 'object' && typeof b === 'object' && a !== null && b !== null) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    changed[key] = a as T[keyof T];
    any = true;
  }
  return any ? changed : null;
}

// === Audio state — lazy. Built on first user gesture (or test-driven ensureAudio). ===

interface AudioState {
  ctx: AudioContext;
  trackAnalysers: AnalyserNode[];
  trackGains: GainNode[];
  // Sparse: a slot has an engine only while its track is enabled. Disabled
  // slots are `undefined` — building all TRACK_POOL_SIZE engines eagerly cost
  // ~190 always-running oscillators rendering silence (a SoundEngine's
  // oscillators start at construction and never stop; gain=0 does not stop a
  // Web Audio subgraph from being processed every quantum).
  engines: (SoundEngine | undefined)[];
  // Engines mid anti-click fade, waiting on their dispose timer. disposeSynth
  // settles these immediately so no timer outlives the AudioContext.
  pendingDisposes: Map<ReturnType<typeof setTimeout>, SoundEngine>;
  scope: EffectScope;
}

// shallowRef so the computed bindings below (trackAnalysers, trackGains) actually
// re-evaluate when ensureAudio() flips this from null → AudioState. A plain
// `let` looks identical here but Vue can't observe the assignment, so the
// computeds would cache the initial null forever (oscilloscope stays flat).
const audioState = shallowRef<AudioState | null>(null);

// === Sync state — built alongside audio (see buildSyncState). ===
//
// Module-scope (like `project`) because there is exactly one room connection
// per tab, shared by every useSynth() consumer.
let wsClient: WsClient | null = null;
let outbox: Outbox | null = null;
const fatalError = ref<{ code: string; message: string } | null>(null);

// True while the current room's initial catch-up is in flight — from
// connectToSession (which resets the local project to blank) until the room
// reaches 'live' on sync.complete. The studio binds a loader to this so the
// freshly-reset empty project isn't shown as a blank session before the
// snapshot lands. Cleared on sync.complete, teardown/leave, or a fatal error.
const roomLoading = ref(false);

// The room this tab is currently connected to (null in the lobby). A ref so the
// shell/sidebar can react (e.g. show the Leave control only inside a session).
const currentRoomId = ref<string | null>(null);

// The current room's display name, loaded by the App shell from getSession()
// whenever currentRoomId changes. null = not loaded / no room; '' = loaded but
// untitled. Rendered (static) in the top app-bar; updated after a local rename.
const sessionName = ref<string | null>(null);

let authWatcherInstalled = false;
let leaveFlushInstalled = false;
function installLeaveFlushHandler(): void {
  if (leaveFlushInstalled) return;
  if (typeof window === 'undefined') return;
  leaveFlushInstalled = true;
  window.addEventListener('beforeunload', () => {
    // Best-effort: the socket is usually still open during beforeunload, so a
    // synchronous flush gets the last throttled edits onto the wire.
    outbox?.flushAllPending();
  });
}

// Flush the outbox entry for `path` immediately — called from a knob's
// gesture-end (mouseup) so the final drag value goes out without waiting out
// the 50ms throttle. No-op when sync is off or nothing is pending. Used by the
// panels via useKnobSync (see sync/knobSync.ts).
export function endGesture(path: Path): void {
  outbox?.flushPath(path);
}

// Tests flip this off so ensureAudio() doesn't open a real socket; production
// leaves it on. Kept here (not a build-time const) so a test can toggle it on
// the freshly-imported module instance.
let syncEnabled = true;
export function setSyncEnabled(v: boolean): void { syncEnabled = v; }

// True once the CURRENT room has reached the live / caught-up state. Outbound
// sync is gated on this so pre-load / stale content is never written up into the
// room — the cause of cross-session content bleed when switching sessions.
// Reset to false on every new room connection (buildSyncState); set true on
// sync.complete (onSyncLive) — NOT on snapshot, because a resumed connection
// catches up via op replay with no snapshot, and that path must open the gate
// too (otherwise edits would be silently dropped). NOT reset on transient
// reconnects, so the offline queue still flushes correctly after a mid-session drop.
let syncReady = false;

// Injectable so tests can hand back a WsClient wired to a MockWebSocket +
// in-memory storage instead of touching the network. Production uses the
// default real constructor.
type WsClientFactory = (opts: WsClientOptions) => WsClient;
let wsClientFactory: WsClientFactory = (opts) => new WsClient(opts);
export function setWsClientFactory(f: WsClientFactory | null): void {
  wsClientFactory = f ?? ((opts) => new WsClient(opts));
}

// Leaf fields edited as a single discrete action (a select or toggle) flush to
// the wire immediately; everything else (knobs/sliders/drags) rides the 50ms
// throttle. Centralized here so the policy lives in one place rather than being
// re-derived inline in each watcher. Keyed by leaf field name — unambiguous
// across the accept-list (no continuous and discrete field share a name).
const DISCRETE_LEAF_FIELDS = new Set<string>([
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType', 'patternLength', 'enabled',
  'sync', // synth2 osc hard-sync toggle: an instantaneous discrete flip, like muted/soloed
  'loop', // synth2 envelope loop toggle (I3c): a discrete flip — flush immediately
  'type', // synth2 filter.type enum: a discrete selector flip — flush immediately
  'source', // synth2 matrix route source enum — discrete selector flip
  'dest',   // synth2 matrix route dest enum — discrete selector flip
  'model',  // synth2 filter.model enum (I3d): a discrete selector flip — flush immediately
  // ('amount' is intentionally NOT here — a continuous knob that rides the throttle.)
]);
function gestureEndForLeaf(leafKey: string): boolean {
  return DISCRETE_LEAF_FIELDS.has(leafKey);
}

// Emit the leaf-level outbound ops for one diffed object at `prefix`. The
// accept-list forbids whole-object writes, so nested params (filterEnv/ampEnv)
// are drilled one level to their changed a/d/s/r leaves; scalar fields emit a
// single op. `priorValue` is the pre-edit value, carried for nack rollback.
// Shared by the engine-slice, mixer, and step watchers.
function emitLeafDiff(
  prefix: Path,
  changed: Record<string, unknown>,
  oldObj: Record<string, unknown> | undefined,
): void {
  if (!outbox) return;
  for (const [key, value] of Object.entries(changed)) {
    // Arrays (synth2.matrix) are synced by a dedicated per-slot watcher — never
    // drilled here, which would emit a forbidden whole-slot object write.
    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === 'object') {
      const oldNested = (oldObj?.[key] ?? {}) as Record<string, unknown>;
      const newNested = value as Record<string, unknown>;
      for (const subKey of Object.keys(newNested)) {
        if (oldNested[subKey] === newNested[subKey]) continue;
        outbox.enqueue([...prefix, key, subKey], newNested[subKey], oldNested[subKey], gestureEndForLeaf(subKey));
      }
    } else {
      outbox.enqueue([...prefix, key], value, oldObj?.[key], gestureEndForLeaf(key));
    }
  }
}

// Build the room connection + outbox. Does NOT call wsClient.connect() —
// that is the caller's responsibility (connectToSession). Idempotent: if a
// socket is already live, returns immediately.
function buildSyncState(roomId: string): void {
  if (wsClient) return;
  syncReady = false;
  const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_WS_URL;
  const wsUrl = envUrl
    ? `${envUrl.replace(/\/$/, '')}/ws/${roomId}`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`;

  const auth = useAuth();
  wsClient = wsClientFactory({
    url: wsUrl,
    roomId,
    getToken: () => auth.accessToken.value,
    onMessage: (msg) => dispatchServerMessage(msg, {
      project,
      wsClient: wsClient!,
      outbox: outbox!,
      onFatalError: (code, message) => {
        fatalError.value = { code, message };
        // The error overlay takes over; stop showing the loader behind it.
        roomLoading.value = false;
      },
      onSyncLive: () => {
        syncReady = true;
        // Initial catch-up done — the room's content is now applied locally.
        roomLoading.value = false;
      },
    }),
    onStateChange: (s) => {
      if (s === 'closed' && outbox) outbox.onClosed();
    },
  });

  outbox = new Outbox({
    nextClientSeq: () => wsClient!.nextClientSeq(),
    send: (op) => wsClient!.send(op),
    applyLocal: (path: Path, value: unknown) => {
      // Rollback write: suppress so the sync watcher reverts the engine without
      // re-enqueuing the reverted value back to the server.
      enterSuppress();
      try {
        setDeep(project as unknown as Record<string, unknown>, path, value);
      } finally {
        exitSuppress();
      }
    },
    isLive: () => !!wsClient?.isLive(),
  });
  installLeaveFlushHandler();
}

// Installed once (the shell never unmounts). Re-handshakes the live socket when
// the user logs in/out so the server re-derives identity. Watches the user id,
// not the token (Supabase refreshes the token silently).
function installAuthReconnectWatcher(): void {
  if (authWatcherInstalled) return;
  authWatcherInstalled = true;
  const auth = useAuth();
  watch(
    () => auth.session.value?.user.id ?? null,
    (next, prev) => {
      if (next === prev) return;
      wsClient?.reconnect();
    },
  );
}

// Tear down only the room connection (audio stays alive). Shared by leaveSession,
// room-switching, and disposeSynth.
// Module-scope EffectScope holding the OUTBOUND-SYNC watchers. Its lifecycle is
// the room connection (created in connectToSession, stopped in teardown), NOT
// the audio graph. This is the whole point of the split: outbound sync is a
// function of (reactive project, connection) with no dependency on the
// AudioContext, so installing it here — rather than inside buildAudioState,
// which only runs on the first PLAY gesture — is what lets edits made before
// the first Play actually reach the server. The audio-reaction watchers (engine
// + gain side effects) stay in buildAudioState because they genuinely need the
// engines; the two sets are kept disjoint so no field is emitted twice once both
// are live after Play.
let syncWatcherScope: EffectScope | null = null;

function installSyncWatchers(): void {
  if (syncWatcherScope) return; // idempotent — exactly one set per connection
  syncWatcherScope = effectScope(true);
  syncWatcherScope.run(() => {
    // Every watcher below uses flush:'sync' so the applyingFromNetwork guard —
    // held synchronously during applyOp/replaceProject — actually covers the
    // fire (async flush would clear it first and remote ops would echo back
    // out), and gates on `outbox && syncReady && !isApplyingFromNetwork()` so
    // nothing leaks before the room is live or while applying a remote op.
    watch(
      () => project.bpm,
      (newVal, oldVal) => {
        if (outbox && syncReady && !isApplyingFromNetwork()) {
          outbox.enqueue(['bpm'], newVal, oldVal, gestureEndForLeaf('bpm'));
        }
      },
      { flush: 'sync' },
    );

    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      watch(
        () => project.tracks[i].engineType,
        (newType, oldType) => {
          if (outbox && syncReady && !isApplyingFromNetwork()) {
            outbox.enqueue(['tracks', i, 'engineType'], newType, oldType, gestureEndForLeaf('engineType'));
          }
        },
        { flush: 'sync' },
      );

      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(project.tracks[i].engines[slice]),
          (newVal, oldVal) => {
            if (!outbox || !syncReady || isApplyingFromNetwork()) return;
            const changed = diffParams(
              newVal as unknown as Record<string, unknown>,
              oldVal as unknown as Record<string, unknown>,
            );
            // Emit regardless of whether this is the active slice so peers stay
            // in sync for edits to any writable param.
            if (changed) emitLeafDiff(['tracks', i, 'engines', slice], changed, oldVal as unknown as Record<string, unknown>);
          },
          { flush: 'sync' },
        );
      }

      watch(
        () => snapshot(project.tracks[i].mixer),
        (newVal, oldVal) => {
          if (!outbox || !syncReady || isApplyingFromNetwork()) return;
          const changed = diffParams(
            newVal as unknown as Record<string, unknown>,
            oldVal as unknown as Record<string, unknown>,
          );
          if (changed) emitLeafDiff(['tracks', i, 'mixer'], changed, oldVal as unknown as Record<string, unknown>);
        },
        { flush: 'sync' },
      );

      watch(
        () => snapshot(project.tracks[i].steps),
        (newSteps, oldSteps) => {
          if (!outbox || !syncReady || isApplyingFromNetwork() || !oldSteps) return;
          for (let j = 0; j < newSteps.length; j++) {
            const changed = diffParams(
              newSteps[j] as unknown as Record<string, unknown>,
              oldSteps[j] as unknown as Record<string, unknown>,
            );
            if (changed) emitLeafDiff(['tracks', i, 'steps', j], changed, oldSteps[j] as unknown as Record<string, unknown>);
          }
        },
        { flush: 'sync' },
      );

      // synth2 mod matrix: an array of {source,dest,amount} slots. The
      // engine-slice watcher's emitLeafDiff skips arrays (a one-level drill would
      // emit a forbidden whole-slot object write), so the matrix is synced here —
      // drilled to leaf paths per slot. source/dest are discrete enum flips
      // (DISCRETE_LEAF_FIELDS → flush immediately); amount is a continuous knob
      // (rides the throttle). Mirrors the steps watcher's guards + flush:'sync'.
      watch(
        () => snapshot(project.tracks[i].engines.synth2.matrix),
        (newM, oldM) => {
          if (!outbox || !syncReady || isApplyingFromNetwork() || !oldM) return;
          for (let s = 0; s < newM.length; s++) {
            for (const field of ['source', 'dest', 'amount'] as const) {
              const a = (newM[s] as unknown as Record<string, unknown>)[field];
              const b = (oldM[s] as unknown as Record<string, unknown>)[field];
              if (a === b) continue;
              outbox.enqueue(['tracks', i, 'engines', 'synth2', 'matrix', s, field], a, b, gestureEndForLeaf(field));
            }
          }
        },
        { flush: 'sync' },
      );

      watch(
        () => project.tracks[i].patternLength,
        (newVal, oldVal) => {
          if (outbox && syncReady && !isApplyingFromNetwork()) {
            outbox.enqueue(['tracks', i, 'patternLength'], newVal, oldVal, gestureEndForLeaf('patternLength'));
          }
        },
        { flush: 'sync' },
      );

      watch(
        () => project.tracks[i].enabled,
        (newVal, oldVal) => {
          if (outbox && syncReady && !isApplyingFromNetwork()) {
            outbox.enqueue(['tracks', i, 'enabled'], newVal, oldVal, gestureEndForLeaf('enabled'));
          }
        },
        { flush: 'sync' },
      );
    }
  });
}

function disposeSyncWatchers(): void {
  syncWatcherScope?.stop();
  syncWatcherScope = null;
}

function teardownConnection(): void {
  // Deliver any throttled pending edits to the (still-live) socket before we
  // close it, so leaving a room / switching rooms can't strand the last edits.
  outbox?.flushAllPending();
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
  outbox = null;
  // Drop the outbound-sync watchers with the connection. Done before
  // resetLocalProject runs (in connectToSession / leaveSession) so the reset to
  // a fresh project can't be observed and enqueued as local edits.
  disposeSyncWatchers();
  fatalError.value = null;
  roomLoading.value = false;
  currentRoomId.value = null;
  resetPresence();
}

// Enter a session: bring up the room connection for `roomId` and reflect it in
// the URL. Idempotent for the same room; switches cleanly between rooms. Does
// NOT touch audio — the AudioContext still boots lazily on first PLAY.
export function connectToSession(roomId: string): void {
  setRoomInUrl(roomId);
  if (!syncEnabled) { currentRoomId.value = roomId; return; }
  if (wsClient && currentRoomId.value === roomId) return;
  if (wsClient) teardownConnection();
  // Drop the previous session's (or localStorage's) content before connecting so
  // it can't play, or be synced up into this room, before this room's snapshot
  // arrives. `outbox` is null here (teardown / first connect), so no enqueue.
  resetLocalProject();
  currentRoomId.value = roomId;
  // Show the loader until this room's snapshot/catch-up completes (onSyncLive).
  roomLoading.value = true;
  installAuthReconnectWatcher();
  buildSyncState(roomId);
  // Outbound sync is live from here — independent of audio. The watchers still
  // gate on syncReady (false until sync.complete), so nothing leaks during the
  // initial catch-up; they just no longer wait for the first PLAY to exist.
  installSyncWatchers();
  // Force a full snapshot: we just reset the local project, so a resume delta
  // (op replay since opIdLastSeen) would apply onto an empty project and leave
  // the room blank. forceSnapshot keeps our identity but pulls the whole room.
  wsClient!.connect({ forceSnapshot: true });
}

// Reset local project state to a neutral fresh project. Shared by leaveSession
// and connectToSession; only safe to call while `outbox` is null (otherwise the
// sync watchers would enqueue the reset as local edits).
function resetLocalProject(): void {
  replaceProject(project, freshProject());
  resetApplyOpState();
}

// Leave the current session: drop the connection, reset local state to a neutral
// project, and clear the room from the URL. Audio stays alive.
export function leaveSession(): void {
  teardownConnection();
  resetLocalProject();
  clearRoomFromUrl();
}

async function buildAudioState(): Promise<AudioState> {
  const ctx = new AudioContext();

  // Pulse oscillator worklet must be registered before any SynthVoice (and
  // its inner OscillatorModule) constructs an AudioWorkletNode('pulse'). The
  // module load is async; the rest of the graph wiring must wait.
  await ctx.audioWorklet.addModule(pulseWorkletUrl);

  // synth2 worklet must likewise be registered before any Synth2Engine
  // constructs an AudioWorkletNode('synth2').
  await ctx.audioWorklet.addModule(synth2WorkletUrl);

  // kick2 worklet must likewise be registered before any Kick2Engine constructs
  // an AudioWorkletNode('kick2').
  await ctx.audioWorklet.addModule(kick2WorkletUrl);

  // snare2 worklet must likewise be registered before any Snare2Engine constructs
  // an AudioWorkletNode('snare2').
  await ctx.audioWorklet.addModule(snare2WorkletUrl);

  // hat2 worklet must likewise be registered before any Hat2Engine constructs an
  // AudioWorkletNode('hat2').
  await ctx.audioWorklet.addModule(hat2WorkletUrl);

  // clap2 worklet must likewise be registered before any Clap2Engine constructs an
  // AudioWorkletNode('clap2').
  await ctx.audioWorklet.addModule(clap2WorkletUrl);

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-12, ctx.currentTime);
  compressor.knee.setValueAtTime(30, ctx.currentTime);
  compressor.ratio.setValueAtTime(12, ctx.currentTime);
  compressor.attack.setValueAtTime(0.003, ctx.currentTime);
  compressor.release.setValueAtTime(0.25, ctx.currentTime);

  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.6, ctx.currentTime);

  compressor.connect(masterGain);
  masterGain.connect(ctx.destination);

  // Per-track analysers tee off each trackGain so the focused panel's
  // oscilloscope shows only that channel, not the summed mix.
  // Gains + analysers stay eager for all pool slots (unlike engines): with no
  // source connected they render nothing per quantum, and a fixed dense array
  // keeps the Visualizer's by-index binding trivial. The expensive part — the
  // engines' always-running oscillators — is built lazily per enabled slot.
  const trackGains: GainNode[] = [];
  const trackAnalysers: AnalyserNode[] = [];
  for (let i = 0; i < TRACK_POOL_SIZE; i++) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, ctx.currentTime);
    g.connect(compressor);
    const a = ctx.createAnalyser();
    a.fftSize = 1024;
    g.connect(a);
    trackGains.push(g);
    trackAnalysers.push(a);
  }

  const engines: (SoundEngine | undefined)[] = new Array(TRACK_POOL_SIZE).fill(undefined);

  const pendingDisposes: Map<ReturnType<typeof setTimeout>, SoundEngine> = new Map();

  // Fade trackGain to 0 over ~20ms so dispose()'s synchronous osc.stop()
  // doesn't click, then dispose and restore gains (D4 semantics). Shared by
  // engine-type swaps and slot disables. The timer is tracked in
  // pendingDisposes so disposeSynth can settle it early.
  const fadeOutAndDispose = (i: number, engine: SoundEngine) => {
    trackGains[i].gain.setTargetAtTime(0, ctx.currentTime, ENGINE_SWAP_FADE_SECONDS / 3);
    const timer = setTimeout(() => {
      pendingDisposes.delete(timer);
      engine.dispose();
      updateMixerGains();
    }, (ENGINE_SWAP_FADE_SECONDS * 1000) + 5);
    pendingDisposes.set(timer, engine);
  };

  const syncTrackToEngine = (i: number) => {
    const track = project.tracks[i];
    const existing = engines[i];

    // Disabled slot: no engine at all. Tear down whatever is there so a
    // disabled track costs zero audio-thread time, not just zero gain.
    if (!track.enabled) {
      if (existing) {
        engines[i] = undefined;
        fadeOutAndDispose(i, existing);
      }
      return;
    }

    const targetType = track.engineType;
    if (!existing || existing.engineType !== targetType) {
      if (existing) fadeOutAndDispose(i, existing);
      engines[i] = engineFactories[targetType](ctx, trackGains[i]);
    }

    engines[i]!.applyParams(track.engines[targetType] as Record<string, any>);
  };

  const updateMixerGains = () => {
    // Solo is scoped to enabled tracks only — soloing has no meaning for a
    // disabled slot, and a disabled slot must never count toward anySoloed.
    const anySoloed = project.tracks.some(t => t.enabled && t.mixer?.soloed);
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      const track = project.tracks[i];
      // A disabled slot is always silent regardless of its mixer state.
      const audible = track.enabled && (anySoloed
        ? (track.mixer.soloed && !track.mixer.muted)
        : !track.mixer.muted);
      const targetGain = audible ? sliderToLinearGain(track.mixer.volume) : 0;
      trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
    }
  };

  // Build engines for ENABLED slots only + apply their current project tracks
  // (which may already carry pre-play knob edits). Disabled slots stay empty
  // until their `enabled` watcher fires.
  for (let i = 0; i < TRACK_POOL_SIZE; i++) {
    syncTrackToEngine(i);
  }
  updateMixerGains();

  // Audio-reaction watchers ONLY: they drive the engine graph and track gains,
  // so they live with the AudioContext (built on first PLAY). The watchers that
  // EMIT sync ops live in installSyncWatchers(), tied to the room connection —
  // see the note there. Nothing in this scope enqueues an op; doing so would
  // double-emit once both sets are live. bpm/steps/patternLength have no engine
  // reaction (the sequencer reads them live each tick), so they aren't watched
  // here at all. flush:'sync' keeps each reaction in step with the synchronous
  // applyOp write, and the bodies are guard-free so remote ops drive audio too.
  const scope = effectScope(true);
  scope.run(() => {
    for (let i = 0; i < TRACK_POOL_SIZE; i++) {
      // Engine-type change: dispose the old engine, build the new one, apply the
      // whole slice. Fires for remote swaps too, so a peer's change rebuilds the
      // local audio graph.
      watch(
        () => project.tracks[i].engineType,
        () => { syncTrackToEngine(i); },
        { flush: 'sync' },
      );

      // Per-slice param edits feed the active engine. snapshot()+diff lets Vue
      // track nested fields without deep:true and gives a real before/after. A
      // non-active slice's params apply when it becomes active (the engineType
      // watcher rebuilds it).
      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(project.tracks[i].engines[slice]),
          (newVal, oldVal) => {
            if (project.tracks[i].engineType !== slice) return;
            const engine = engines[i];
            if (!engine) return; // disabled slot — params apply on enable via syncTrackToEngine
            const changed = diffParams(
              newVal as unknown as Record<string, unknown>,
              oldVal as unknown as Record<string, unknown>,
            );
            if (changed) engine.applyParams(changed);
          },
          { flush: 'sync' },
        );
      }

      // Mixer: any change recomputes all track gains (solo logic is global).
      watch(
        () => snapshot(project.tracks[i].mixer),
        () => { updateMixerGains(); },
        { flush: 'sync' },
      );

      // enabled toggles the slot's engine lifecycle: enable constructs the
      // engine (and applies the slice), disable fade-disposes it — engines
      // exist only for enabled slots. updateMixerGains re-gates the trackGain
      // either way. Fires for remote toggles too.
      watch(
        () => project.tracks[i].enabled,
        () => {
          syncTrackToEngine(i);
          updateMixerGains();
        },
        { flush: 'sync' },
      );
    }
  });

  return { ctx, trackAnalysers, trackGains, engines, pendingDisposes, scope };
}

// Single-flight bootstrap. Concurrent ensureAudio() calls during the
// addModule window share one Promise so we never spawn two AudioContexts.
let bootstrapping: Promise<AudioState> | null = null;

async function ensureAudio(): Promise<AudioState> {
  if (audioState.value) return audioState.value;
  if (!bootstrapping) {
    bootstrapping = buildAudioState().then(s => {
      audioState.value = s;
      return s;
    });
  }
  return bootstrapping;
}

// Exposed primarily for tests; production code does not call this.
export function disposeSynth() {
  const state = audioState.value;
  if (!state) return;
  state.scope.stop();
  // Settle in-flight fade-disposes first so their timers never fire against a
  // closed AudioContext (or, in tests, after globals are torn down).
  for (const [timer, engine] of state.pendingDisposes) {
    clearTimeout(timer);
    engine.dispose();
  }
  state.pendingDisposes.clear();
  for (const engine of state.engines) {
    engine?.dispose(); // sparse — disabled slots have no engine
  }
  state.ctx.close().catch(() => { /* ctx may already be closed */ });
  audioState.value = null;
  bootstrapping = null;

  // Tear down the sync layer too so a re-init (or a test) starts clean.
  teardownConnection();
  resetApplyOpState();
}

export function useSynth() {
  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null); // null means the track overview

  const waveforms: OscillatorTypeLiteral[] = ['sine', 'square', 'sawtooth', 'triangle'];

  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { project.bpm = v; },
  });

  // The currently-focused track, or null on the track overview. Panels read
  // their reactive engine slice from this (e.g. focusedTrack.value.engines.synth);
  // mutating that slice writes straight through to `project`, driving the
  // existing slice watchers (audio + outbox). Replaces the per-param trackParam
  // refs that previously projected each field individually.
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

  // Audio-derived bindings. `trackAnalysers` returns null until first
  // ensureAudio() so Visualizer renders a flat line during the pre-gesture window.
  const trackAnalysers: ComputedRef<AnalyserNode[] | null> = computed(() => audioState.value?.trackAnalysers ?? null);
  const trackGains: ComputedRef<GainNode[] | null> = computed(() => audioState.value?.trackGains ?? null);

  const togglePlay = async () => {
    // First user gesture: this is where the AudioContext + engines + watchers
    // come alive. Doing it here (not at module load) eliminates Chrome's
    // "AudioContext was not allowed to start" warning. The await covers the
    // worklet module load (~few ms on first play, instant thereafter).
    const state = await ensureAudio();

    if (state.ctx.state === 'suspended') {
      state.ctx.resume();
    }

    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    } else {
      sequencer.start(state.ctx, () => project.bpm, (stepIndex, time) => {
        currentStep.value = stepIndex;

        for (let i = 0; i < TRACK_POOL_SIZE; i++) {
          const track = project.tracks[i];
          if (!track.enabled) continue;
          // Engine construction rides the synchronous enabled watcher, so an
          // enabled track always has one — guard anyway so a scheduling tick
          // racing a toggle can't crash the audio callback.
          const engine = state.engines[i];
          if (!engine) continue;
          const step = track.steps[stepIndex % track.patternLength];
          if (step.note && !step.muted) {
            const engineTypeI = track.engineType;
            if (engineTypeI === 'synth') {
              const currentMode = track.engines.synth.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                engine.trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                engine.trigger(freq, duration, time, step.velocity);
              }
            } else if (engineTypeI === 'synth2') {
              const currentMode = track.engines.synth2.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                engine.trigger(freqs, duration, time, step.velocity);
              } else {
                engine.trigger(noteToFreq(step.note, step.octave), duration, time, step.velocity);
              }
            } else {
              // Drums are fire-and-forget: pitch + decay come from the engine's
              // Tune/Decay knobs, not from step data. freq/duration are passed
              // as 0 — every drum engine ignores them. step.note here is used
              // only as a trigger flag (null = no trigger) by the outer if.
              engine.trigger(0, 0, time, step.velocity);
            }
          }
        }
      });
    }
  };

  // Stop the sequencer if it's running. Used when leaving the studio for the
  // lobby (a non-playback context): there's nothing to play there, and after a
  // leave the project is reset to empty, so a running transport would just loop
  // silence. No-op if audio never booted or playback is already stopped; the
  // audio graph stays up so the next PLAY is instant.
  const stopPlayback = () => {
    if (sequencer.isPlaying) {
      sequencer.stop();
      currentStep.value = -1;
    }
  };

  const selectTrack = (index: number | null) => {
    activeTrackIndex.value = index;
  };

  const getTrackEngineType = (index: number): EngineType => {
    return project.tracks[index].engineType;
  };

  // How many of the fixed 32-slot pool are currently enabled (= "the track
  // count" the UI shows).
  const enabledTrackCount = computed(() => project.tracks.filter(t => t.enabled).length);

  // Add a track = enable the lowest-index disabled slot (fills a freed hole if
  // any). No-op when the pool is full. The enabled watcher emits the sync op
  // and re-gates audio.
  const addTrack = (): void => {
    const idx = project.tracks.findIndex(t => !t.enabled);
    if (idx !== -1) project.tracks[idx].enabled = true;
  };

  // Remove a track = disable that slot (non-destructive; step/param data stays
  // so re-adding restores it). Refused when it would leave zero enabled tracks.
  const removeTrack = (index: number): void => {
    if (index < 0 || index >= TRACK_POOL_SIZE) return;
    if (!project.tracks[index].enabled) return;
    if (enabledTrackCount.value <= 1) return;
    project.tracks[index].enabled = false;
  };

  return {
    project,                                       // NEW: single source of truth
    sequencer,
    bpm,                                           // NEW: writable computed against project.bpm
    trackAnalysers,
    trackGains,
    activeTrackIndex,
    focusedTrack,
    currentStep,
    waveforms,
    shortestActiveNoteDuration,
    togglePlay,
    stopPlayback,
    selectTrack,
    getTrackEngineType,
    enabledTrackCount,
    addTrack,
    removeTrack,
    // Force audio init without playing — needed by tests and any consumer
    // that needs the audio graph up before the first togglePlay.
    ensureAudio,
    // --- Sync surface (read by Sidebar / AccountView / ErrorOverlay) ---
    fatalError,       // ref<{code,message}|null> — set on a fatal server error
    roomLoading,      // ref<boolean> — true while the room's initial catch-up runs
    roster,           // ref<Identity[]> — everyone in the room
    selfClientId,     // ref<string|null> — which roster entry is us
    currentRoomId,
    sessionName,
    connectToSession,
    leaveSession,
  };
}
