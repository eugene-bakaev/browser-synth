import { ref, reactive, computed, shallowRef, type Ref, type ComputedRef } from 'vue';
import { TRACK_POOL_SIZE, divisionToHz } from '@fiddle/shared';
import { type Project, type EngineType } from '../project';
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
import type { AppliedCommand } from '../project/appliedCommand';

// Worklet asset URL — must be a separate browser asset loaded via
// audioContext.audioWorklet.addModule, not bundled into the main chunk. Vite
// recognizes the `new URL(string-literal, import.meta.url)` pattern and emits
// the file alongside the main bundle with a hashed filename. The processor
// inside registers itself as 'pulse'. (Path is identical from audio/ or
// composables/ — both are one level under src/.)
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

const ENGINE_SWAP_FADE_SECONDS = 0.02;

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

// A synced LFO's rate is derived on the main thread from its note division and
// the project BPM (the kernel is tempo-agnostic); a free LFO uses its stored Hz.
function effectiveLfoRate(lfo: { sync?: boolean; div?: string; rate: number }, bpm: number): number {
  return lfo.sync ? divisionToHz(lfo.div ?? '1/16', bpm) : lfo.rate;
}

export interface AudioState {
  ctx: AudioContext;
  trackAnalysers: AnalyserNode[];
  trackGains: GainNode[];
  // Sparse: a slot has an engine only while its track is enabled. Disabled
  // slots are `undefined` — building all TRACK_POOL_SIZE engines eagerly cost
  // ~190 always-running oscillators rendering silence.
  engines: (SoundEngine | undefined)[];
  // Engines mid anti-click fade, waiting on their dispose timer. dispose()
  // settles these immediately so no timer outlives the AudioContext.
  pendingDisposes: Map<ReturnType<typeof setTimeout>, SoundEngine>;
  // Applied-command stream subscription torn down in dispose().
  unsubscribe: () => void;
}

export interface AudioEngineDeps {
  project: Project;
  /** Subscribe to the bus's applied-command stream; returns an unsubscribe. */
  subscribe: (listener: (cmd: AppliedCommand) => void) => () => void;
}

// AudioEngine — owns the AudioContext, the per-track sound engines, the track
// gains/analysers, the audio-reaction stream subscription, the Sequencer, and the transport
// (currentStep). Extracted from useSynth (Phase 4) so audio ownership + teardown
// are explicit. Long-lived, one per tab; the graph boots lazily on the first
// ensureAudio()/togglePlay(), and dispose() is the idempotent full teardown.
// Imports nothing from sync/ or useSynth — a one-directional, cycle-free edge.
export class AudioEngine {
  readonly sequencer = reactive(new Sequencer());
  readonly currentStep: Ref<number> = ref(-1);

  // shallowRef so the computed bindings below re-evaluate when ensureAudio()
  // flips this from null -> AudioState. A plain field would not be observed by
  // Vue, so the computeds would cache the initial null forever.
  private readonly audioState = shallowRef<AudioState | null>(null);

  // Single-flight bootstrap. Concurrent ensureAudio() calls during the
  // addModule window share one Promise so we never spawn two AudioContexts.
  private bootstrapping: Promise<AudioState> | null = null;

  // Audio-derived bindings. Return null until first ensureAudio() so the
  // Visualizer renders a flat line during the pre-gesture window.
  readonly trackAnalysers: ComputedRef<AnalyserNode[] | null> = computed(() => this.audioState.value?.trackAnalysers ?? null);
  readonly trackGains: ComputedRef<GainNode[] | null> = computed(() => this.audioState.value?.trackGains ?? null);

  constructor(private readonly deps: AudioEngineDeps) {}

  private async buildAudioState(): Promise<AudioState> {
    const project = this.deps.project;
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
    // pendingDisposes so dispose() can settle it early.
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

      const params = track.engines[targetType] as Record<string, any>;
      if (targetType === 'synth2') {
        const s2 = params as unknown as { lfo1: any; lfo2: any };
        engines[i]!.applyParams({
          ...params,
          lfo1: { ...s2.lfo1, rate: effectiveLfoRate(s2.lfo1, project.bpm) },
          lfo2: { ...s2.lfo2, rate: effectiveLfoRate(s2.lfo2, project.bpm) },
        });
      } else {
        engines[i]!.applyParams(params);
      }
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

    // Audio reactions ride the bus's applied-command stream (Phase 5) instead
    // of Vue watchers: the bus emits synchronously after every state write —
    // local dispatch, remote op, nack rollback — the same timing flush:'sync'
    // gave the old watchers. `replace` (snapshot / Open / New / room reset)
    // re-runs the same full sync the initial build above just did. The handler
    // only touches audio nodes — never dispatches (bus stream constraint).
    const onCommand = (cmd: AppliedCommand): void => {
      if (cmd.kind === 'replace') {
        for (let i = 0; i < TRACK_POOL_SIZE; i++) syncTrackToEngine(i);
        updateMixerGains();
        return;
      }
      const p = cmd.path;
      // A synced LFO derives its rate from BPM on the main thread, so a tempo
      // change must re-push the derived Hz to every synth2 engine that has one.
      // Everything else still "pulls bpm per tick" (the guard below).
      if (p[0] === 'bpm') {
        for (let i = 0; i < TRACK_POOL_SIZE; i++) {
          if (project.tracks[i].engineType !== 'synth2') continue;
          const engine = engines[i];
          if (!engine) continue;
          for (const key of ['lfo1', 'lfo2'] as const) {
            const lfo = project.tracks[i].engines.synth2[key];
            if (!lfo.sync) continue;
            engine.applyParams({ [key]: { ...snapshot(lfo), rate: effectiveLfoRate(lfo, project.bpm) } });
          }
        }
        return;
      }
      if (p[0] !== 'tracks' || typeof p[1] !== 'number') return; // bpm etc.: sequencer pulls per tick
      const i = p[1];
      switch (p[2]) {
        case 'engineType':
          syncTrackToEngine(i);
          return;
        case 'enabled':
          syncTrackToEngine(i);
          updateMixerGains();
          return;
        case 'mixer':
          updateMixerGains();
          return;
        case 'engines': {
          const slice = p[3] as EngineType;
          if (project.tracks[i].engineType !== slice) return; // inactive slice
          const engine = engines[i];
          if (!engine) return; // disabled slot — params apply on enable via syncTrackToEngine
          const key = p[4];
          if (typeof key !== 'string') return;
          // Re-read the top-level key from live state: a nested-leaf edit
          // applies its whole sub-object (superset — applyParams setters are
          // idempotent per param); a matrix slot edit applies the whole matrix.
          const liveSlice = project.tracks[i].engines[slice] as unknown as Record<string, unknown>;
          if (slice === 'synth2' && (key === 'lfo1' || key === 'lfo2')) {
            const lfo = liveSlice[key] as { sync?: boolean; div?: string; rate: number };
            engine.applyParams({ [key]: { ...snapshot(lfo), rate: effectiveLfoRate(lfo, project.bpm) } });
            return;
          }
          engine.applyParams({ [key]: snapshot(liveSlice[key]) } as Record<string, any>);
          return;
        }
        default:
          return; // steps / patternLength — pull model, no audio reaction
      }
    };
    const unsubscribe = this.deps.subscribe(onCommand);

    return { ctx, trackAnalysers, trackGains, engines, pendingDisposes, unsubscribe };
  }

  ensureAudio = async (): Promise<AudioState> => {
    if (this.audioState.value) return this.audioState.value;
    if (!this.bootstrapping) {
      this.bootstrapping = this.buildAudioState().then((s) => {
        this.audioState.value = s;
        return s;
      });
    }
    return this.bootstrapping;
  };

  togglePlay = async (): Promise<void> => {
    const project = this.deps.project;
    // First user gesture: this is where the AudioContext + engines + stream
    // subscription come alive. Doing it here (not at module load) eliminates Chrome's
    // "AudioContext was not allowed to start" warning.
    const state = await this.ensureAudio();

    if (state.ctx.state === 'suspended') {
      state.ctx.resume();
    }

    if (this.sequencer.isPlaying) {
      this.sequencer.stop();
      this.currentStep.value = -1;
    } else {
      this.sequencer.start(state.ctx, () => project.bpm, (stepIndex, time) => {
        this.currentStep.value = stepIndex;

        for (let i = 0; i < TRACK_POOL_SIZE; i++) {
          const track = project.tracks[i];
          if (!track.enabled) continue;
          // Engine construction rides the synchronous enabled stream reaction,
          // so an enabled track always has one — guard anyway so a scheduling tick
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
  // lobby. No-op if audio never booted or playback is already stopped; the
  // audio graph stays up so the next PLAY is instant.
  stopPlayback = (): void => {
    if (this.sequencer.isPlaying) {
      this.sequencer.stop();
      this.currentStep.value = -1;
    }
  };

  // Idempotent full teardown for page unload / HMR / tests. Stops the transport,
  // settles in-flight fade-disposes, disposes all engines, and closes the ctx.
  // A second call is a no-op (audioState already null). Does NOT touch sync.
  dispose(): void {
    const state = this.audioState.value;
    if (!state) return;
    state.unsubscribe();
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
    this.audioState.value = null;
    this.bootstrapping = null;
    // Stop the transport so no scheduler interval outlives the closed ctx
    // (the orphaned-transport fix this extraction exists to make explicit).
    this.sequencer.stop();
    this.currentStep.value = -1;
  }
}
