import { ref, reactive, watch, computed, effectScope, shallowRef, type EffectScope, type ComputedRef } from 'vue';
import type { OscillatorTypeLiteral } from '@fiddle/shared';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import { Sequencer } from '../sequencer/Sequencer';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';
// Worklet asset URL — must be a separate browser asset loaded via
// audioContext.audioWorklet.addModule, not bundled into the main chunk. Vite
// recognizes the `new URL(string-literal, import.meta.url)` pattern and emits
// the file alongside the main bundle with a hashed filename. The processor
// inside registers itself as 'pulse'.
const pulseWorkletUrl = new URL('../engine/worklets/pulse-processor.js', import.meta.url).href;

import {
  type Project,
  type ProjectTrack,
  type EngineType,
  loadProject,
  installAutoSave,
} from '../project';

// --- Sync layer (WebSocket collaboration) ---
import { WsClient, type WsClientOptions } from '../sync/WsClient';
import { Outbox } from '../sync/Outbox';
import { isApplyingFromNetwork, enterSuppress, exitSuppress, resetApplyOpState } from '../sync/applyOp';
import { setDeep } from '@fiddle/shared';
import { resolveRoomIdFromUrl } from '../sync/roomId';
import { dispatchServerMessage } from '../sync/messageDispatch';
import { roster, selfClientId, resetPresence } from '../sync/presence';
import type { Path } from '@fiddle/shared';

// === Pure data state — built from localStorage (or fresh) at module init. ===

const project: Project = reactive(loadProject());
installAutoSave(project);   // debounced localStorage writes

const sequencer = reactive(new Sequencer());

// === Engine factories — unchanged ===
const ENGINE_SWAP_FADE_SECONDS = 0.02;

const ENGINE_SLICES: EngineType[] = ['synth', 'kick', 'hat', 'snare', 'clap'];

const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth: (ctx, dest) => new SynthEngine(ctx, dest),
  kick:  (ctx, dest) => new KickEngine(ctx, dest),
  hat:   (ctx, dest) => new HatEngine(ctx, dest),
  snare: (ctx, dest) => new SnareEngine(ctx, dest),
  clap:  (ctx, dest) => new ClapEngine(ctx, dest),
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
  engines: SoundEngine[];
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
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType',
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

// Build the room connection + outbox and start connecting. Idempotent; called
// from ensureAudio() once the engines exist (the WS doesn't strictly need
// audio, but ordering them keeps a single teardown path in disposeSynth).
function buildSyncState(): void {
  if (wsClient) return;
  const roomId = resolveRoomIdFromUrl();
  const envUrl = (import.meta as unknown as { env?: Record<string, string | undefined> })
    .env?.VITE_WS_URL;
  const wsUrl = envUrl
    ? `${envUrl.replace(/\/$/, '')}/ws/${roomId}`
    : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`;

  wsClient = wsClientFactory({
    url: wsUrl,
    roomId,
    onMessage: (msg) => dispatchServerMessage(msg, {
      project,
      wsClient: wsClient!,
      outbox: outbox!,
      onFatalError: (code, message) => { fatalError.value = { code, message }; },
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

  wsClient.connect();
}

async function buildAudioState(): Promise<AudioState> {
  const ctx = new AudioContext();

  // Pulse oscillator worklet must be registered before any SynthVoice (and
  // its inner OscillatorModule) constructs an AudioWorkletNode('pulse'). The
  // module load is async; the rest of the graph wiring must wait.
  await ctx.audioWorklet.addModule(pulseWorkletUrl);

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
  const trackGains: GainNode[] = [];
  const trackAnalysers: AnalyserNode[] = [];
  for (let i = 0; i < 4; i++) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.8, ctx.currentTime);
    g.connect(compressor);
    const a = ctx.createAnalyser();
    a.fftSize = 1024;
    g.connect(a);
    trackGains.push(g);
    trackAnalysers.push(a);
  }

  const engines: SoundEngine[] = [];

  const syncTrackToEngine = (i: number) => {
    const track = project.tracks[i];
    const targetType = track.engineType;
    const existing = engines[i];

    if (!existing || existing.engineType !== targetType) {
      if (existing) {
        // Fade trackGain to 0 over ~20ms so dispose()'s synchronous osc.stop() doesn't click.
        trackGains[i].gain.setTargetAtTime(0, ctx.currentTime, ENGINE_SWAP_FADE_SECONDS / 3);
        const oldEngine = existing;
        setTimeout(() => {
          oldEngine.dispose();
          updateMixerGains();
        }, (ENGINE_SWAP_FADE_SECONDS * 1000) + 5);
      }
      engines[i] = engineFactories[targetType](ctx, trackGains[i]);
    }

    engines[i].applyParams(track.engines[targetType] as Record<string, any>);
  };

  const updateMixerGains = () => {
    const anySoloed = project.tracks.some(t => t.mixer?.soloed);
    for (let i = 0; i < 4; i++) {
      const track = project.tracks[i];
      const audible = anySoloed
        ? (track.mixer.soloed && !track.mixer.muted)
        : !track.mixer.muted;
      const targetGain = audible ? sliderToLinearGain(track.mixer.volume) : 0;
      trackGains[i].gain.setTargetAtTime(targetGain, ctx.currentTime, 0.015);
    }
  };

  // Build engines + apply current project tracks (which may already carry pre-play knob edits).
  for (let i = 0; i < 4; i++) {
    syncTrackToEngine(i);
  }
  updateMixerGains();

  // Watchers live in a detached EffectScope so they can be stopped explicitly
  // via disposeSynth() — without this the original code had no teardown path.
  const scope = effectScope(true);
  scope.run(() => {
    // BPM is global (not per-track). Sync-flush so the applyingFromNetwork guard
    // (held synchronously during applyOp/replaceProject) actually covers the
    // watcher fire — see applyOp.ts. No engine call: the sequencer reads
    // project.bpm directly each tick.
    watch(
      () => project.bpm,
      (newVal, oldVal) => {
        if (outbox && !isApplyingFromNetwork()) {
          outbox.enqueue(['bpm'], newVal, oldVal, gestureEndForLeaf('bpm'));
        }
      },
      { flush: 'sync' },
    );

    for (let i = 0; i < 4; i++) {
      // Engine-type change triggers full sync: dispose old, build new, apply
      // the entire new slice. Slice watchers handle the steady-state case.
      // Sync-flush + suppression guard so a remote swap doesn't echo back out.
      watch(
        () => project.tracks[i].engineType,
        (newType, oldType) => {
          syncTrackToEngine(i);
          if (outbox && !isApplyingFromNetwork()) {
            outbox.enqueue(['tracks', i, 'engineType'], newType, oldType, gestureEndForLeaf('engineType'));
          }
        },
        { flush: 'sync' },
      );

      // Per-slice narrow watchers. Wrapping the getter in snapshot() does two
      // things: (a) Vue tracks every nested field as a dependency (no need
      // for `deep: true`); (b) each fire produces a fresh plain snapshot so
      // newVal/oldVal can be diffed — Vue would otherwise hand us the same
      // reactive proxy reference for both.
      for (const slice of ENGINE_SLICES) {
        watch(
          () => snapshot(project.tracks[i].engines[slice]),
          (newVal, oldVal) => {
            const changed = diffParams(newVal as unknown as Record<string, unknown>, oldVal as unknown as Record<string, unknown>);
            if (!changed) return;
            // Only feed the engine if this slice is the track's active engine;
            // a non-active slice's params apply when it becomes active (the
            // engineType watcher full-syncs).
            if (project.tracks[i].engineType === slice) {
              engines[i].applyParams(changed);
            }
            // Emit regardless of active slice so peers stay in sync for edits
            // to any writable param. Skipped while a network op is being
            // applied (sync flush below means this fires inside the suppressed
            // write, so the guard is still held).
            if (outbox && !isApplyingFromNetwork()) {
              emitLeafDiff(['tracks', i, 'engines', slice], changed, oldVal as unknown as Record<string, unknown>);
            }
          },
          // flush:'sync' so the applyingFromNetwork guard — held synchronously
          // during applyOp/replaceProject — actually covers this watcher fire.
          // With the default async flush the guard would already be cleared by
          // the time the watcher ran, and remote ops would echo back out.
          { flush: 'sync' },
        );
      }

      // Mixer: any change recomputes all 4 track gains (solo logic is global).
      // snapshot()+diff (instead of the old deep watch) lets us emit the
      // individual changed leaf (volume/muted/soloed) outbound. Sync-flush for
      // the suppression guard, as above.
      watch(
        () => snapshot(project.tracks[i].mixer),
        (newVal, oldVal) => {
          updateMixerGains();
          if (outbox && !isApplyingFromNetwork()) {
            const changed = diffParams(
              newVal as unknown as Record<string, unknown>,
              oldVal as unknown as Record<string, unknown>,
            );
            if (changed) emitLeafDiff(['tracks', i, 'mixer'], changed, oldVal as unknown as Record<string, unknown>);
          }
        },
        { flush: 'sync' },
      );

      // Steps have no engine reaction (the sequencer reads them each tick), so
      // this watcher exists purely to sync edits. Diff per-step and emit the
      // changed leaf for each. Sync-flush + suppression guard, as above.
      watch(
        () => snapshot(project.tracks[i].steps),
        (newSteps, oldSteps) => {
          if (!outbox || isApplyingFromNetwork() || !oldSteps) return;
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
    }
  });

  return { ctx, trackAnalysers, trackGains, engines, scope };
}

// Single-flight bootstrap. Concurrent ensureAudio() calls during the
// addModule window share one Promise so we never spawn two AudioContexts.
let bootstrapping: Promise<AudioState> | null = null;

async function ensureAudio(): Promise<AudioState> {
  if (audioState.value) return audioState.value;
  if (!bootstrapping) {
    bootstrapping = buildAudioState().then(s => {
      audioState.value = s;
      // Bring the room connection up once engines exist. Gated so tests can
      // opt out of opening a socket.
      if (syncEnabled) buildSyncState();
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
  for (const engine of state.engines) {
    engine.dispose();
  }
  state.ctx.close().catch(() => { /* ctx may already be closed */ });
  audioState.value = null;
  bootstrapping = null;

  // Tear down the sync layer too so a re-init (or a test) starts clean.
  if (wsClient) {
    wsClient.disconnect();
    wsClient = null;
  }
  outbox = null;
  fatalError.value = null;
  resetApplyOpState();
  resetPresence();
}

export function useSynth() {
  const currentStep = ref(-1);
  const activeTrackIndex = ref<number | null>(null); // null means 4-track overview

  const waveforms: OscillatorTypeLiteral[] = ['sine', 'square', 'sawtooth', 'triangle'];

  const bpm = computed({
    get: () => project.bpm,
    set: (v: number) => { project.bpm = v; },
  });

  // The currently-focused track, or null on the 4-track overview. Panels read
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
    const activeSteps = track.steps.filter(s => s.note !== null && !s.muted);
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

        for (let i = 0; i < 4; i++) {
          const track = project.tracks[i];
          const step = track.steps[stepIndex];
          if (step.note && !step.muted) {
            const engineTypeI = track.engineType;
            if (engineTypeI === 'synth') {
              const currentMode = track.engines.synth.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                state.engines[i].trigger(freqs, duration, time, step.velocity);
              } else {
                const freq = noteToFreq(step.note, step.octave);
                state.engines[i].trigger(freq, duration, time, step.velocity);
              }
            } else {
              // Drums are fire-and-forget: pitch + decay come from the engine's
              // Tune/Decay knobs, not from step data. freq/duration are passed
              // as 0 — every drum engine ignores them. step.note here is used
              // only as a trigger flag (null = no trigger) by the outer if.
              state.engines[i].trigger(0, 0, time, step.velocity);
            }
          }
        }
      });
    }
  };

  const selectTrack = (index: number | null) => {
    activeTrackIndex.value = index;
  };

  const getTrackEngineType = (index: number): EngineType => {
    return project.tracks[index].engineType;
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
    selectTrack,
    getTrackEngineType,
    // Force audio init without playing — needed by tests and any consumer
    // that needs the audio graph up before the first togglePlay.
    ensureAudio,
    // --- Sync surface (read by RoomBar / ErrorOverlay in Task 16) ---
    fatalError,       // ref<{code,message}|null> — set on a fatal server error
    roster,           // ref<Identity[]> — everyone in the room
    selfClientId,     // ref<string|null> — which roster entry is us
  };
}
