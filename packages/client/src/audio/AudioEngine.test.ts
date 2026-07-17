import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { freshProject, type Project } from '../project';
import { setDeep, TRACK_POOL_SIZE, type Path } from '@fiddle/shared';
import type { AppliedCommand } from '../project/appliedCommand';

// Minimal Web Audio mock (same shape as useSynth.test / TrackMixer.test).
class MockAudioNode { connect = vi.fn(); disconnect = vi.fn(); context = { currentTime: 0 }; }
class MockAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn().mockImplementation((val: number) => { this.value = val; });
}
class MockGainNode extends MockAudioNode { gain = new MockAudioParam(); }
class MockOscillatorNode extends MockAudioNode {
  frequency = new MockAudioParam(); detune = new MockAudioParam(); type = 'sine';
  start = vi.fn(); stop = vi.fn();
}
class MockBiquadFilterNode extends MockAudioNode { frequency = new MockAudioParam(); Q = new MockAudioParam(); type = 'lowpass'; }
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(); knee = new MockAudioParam(); ratio = new MockAudioParam();
  attack = new MockAudioParam(); release = new MockAudioParam();
}
class MockAnalyserNode extends MockAudioNode { fftSize = 1024; }
class MockAudioWorkletNode extends MockAudioNode {
  parameters = new Map<string, MockAudioParam>([
    ['frequency', new MockAudioParam()], ['detune', new MockAudioParam()], ['pulseWidth', new MockAudioParam()],
  ]);
  // synth2/kick2/etc. engines post param/trigger/dispose messages over the
  // worklet port (see Synth2Engine.applyParams) — needed once a test drives
  // one of those engines through AudioEngine, not just the default 'synth'.
  port = { postMessage: vi.fn() };
}
let audioContextCtorCalls = 0;
class MockAudioContext {
  state = 'suspended'; currentTime = 0; sampleRate = 44100;
  destination = new MockAudioNode();
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockImplementation(() => { this.state = 'running'; return Promise.resolve(); });
  constructor() { audioContextCtorCalls++; }
  createGain() { return new MockGainNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
}
vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

import { AudioEngine } from './AudioEngine';

function makeEngine() {
  const project = reactive(freshProject()) as Project;
  const listeners = new Set<(cmd: AppliedCommand) => void>();
  const engine = new AudioEngine({
    project,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  });
  const emit = (cmd: AppliedCommand) => { for (const l of listeners) l(cmd); };
  // Simulate a bus write: state first, then the synchronous stream event.
  const set = (path: Path, value: unknown) => {
    setDeep(project as unknown as Record<string, unknown>, path, value);
    emit({ kind: 'set', path, value });
  };
  return { project, engine, set, emit, listeners };
}

describe('AudioEngine', () => {
  beforeEach(() => { audioContextCtorCalls = 0; });

  it('construction is side-effect-free (no AudioContext, bindings null)', () => {
    const { engine } = makeEngine();
    expect(audioContextCtorCalls).toBe(0);
    expect(engine.trackAnalysers.value).toBeNull();
    expect(engine.trackGains.value).toBeNull();
    expect(engine.sequencer.isPlaying).toBe(false);
  });

  it('ensureAudio builds the graph and is single-flight', async () => {
    const { engine } = makeEngine();
    const [a, b] = await Promise.all([engine.ensureAudio(), engine.ensureAudio()]);
    expect(a).toBe(b);                       // one shared bootstrap
    expect(audioContextCtorCalls).toBe(1);   // exactly one AudioContext
    expect(engine.trackGains.value).toHaveLength(TRACK_POOL_SIZE);
    expect(engine.trackAnalysers.value).toHaveLength(TRACK_POOL_SIZE);
    expect(a.engines[0]).toBeDefined();      // track 0 enabled by default
  });

  it('applies a dispatched param to the active engine (single key, from live state)', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();

    set(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
  });

  it('a DIRECT reactive mutation no longer reaches audio (watchers are gone)', async () => {
    const { project, engine } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();
    project.tracks[0].engines.synth.filterCutoff = 777;   // bypasses the bus
    await nextTick();
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('applies a nested sub-object as a whole re-read superset', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();
    set(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a'], 0.42);
    expect(applySpy).toHaveBeenCalledTimes(1);
    // whole filterEnv (live re-read), not just {a}:
    expect(applySpy.mock.calls[0][0]).toEqual({ filterEnv: expect.objectContaining({ a: 0.42 }) });
  });

  it('ignores a param set for an inactive engine slice', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();
    set(['tracks', 0, 'engines', 'kick', 'level'], 0.5);   // track 0 is synth
    expect(applySpy).not.toHaveBeenCalled();
  });

  it('enabled=false disposes the slot engine; enabled=true rebuilds it', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    expect(state.engines[0]).toBeDefined();
    set(['tracks', 0, 'enabled'], false);
    expect(state.engines[0]).toBeUndefined();
    set(['tracks', 0, 'enabled'], true);
    expect(state.engines[0]).toBeDefined();
  });

  it('engineType set swaps the slot engine', async () => {
    const { engine, set } = makeEngine();
    const state = await engine.ensureAudio();
    const before = state.engines[0]!;
    set(['tracks', 0, 'engineType'], 'kick');
    expect(state.engines[0]).not.toBe(before);
    expect(state.engines[0]!.engineType).toBe('kick');
  });

  it('a replace event re-syncs every slot from current state', async () => {
    const { project, engine, emit } = makeEngine();
    const state = await engine.ensureAudio();
    // wholesale replace outside the leaf-op path (snapshot / Open / New):
    project.tracks[0].engineType = 'kick';
    project.tracks[1].enabled = false;
    emit({ kind: 'replace' });
    expect(state.engines[0]!.engineType).toBe('kick');
    expect(state.engines[1]).toBeUndefined();
  });

  it('dispose unsubscribes from the stream', async () => {
    const { engine, listeners } = makeEngine();
    await engine.ensureAudio();
    expect(listeners.size).toBe(1);
    engine.dispose();
    expect(listeners.size).toBe(0);
  });

  it('dispose closes the ctx, stops the transport, and is idempotent', async () => {
    const { engine } = makeEngine();
    const state = await engine.ensureAudio();
    const closeSpy = state.ctx.close as unknown as ReturnType<typeof vi.fn>;

    await engine.togglePlay();               // start transport
    expect(engine.sequencer.isPlaying).toBe(true);

    engine.dispose();
    expect(engine.sequencer.isPlaying).toBe(false);
    expect(engine.currentStep.value).toBe(-1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(engine.trackGains.value).toBeNull();

    engine.dispose();                        // second call: no-op
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AudioEngine — LFO tempo-sync rate derivation', () => {
  async function synth2Engine(lfo1: Partial<{ sync: boolean; div: string; rate: number }>) {
    const h = makeEngine();
    h.project.bpm = 120;
    h.project.tracks[0].engineType = 'synth2';
    Object.assign(h.project.tracks[0].engines.synth2.lfo1, lfo1);
    const state = await h.engine.ensureAudio();
    const spy = vi.spyOn(state.engines[0]!, 'applyParams');
    spy.mockClear();
    return { ...h, state, spy };
  }

  it('re-pushes a derived Hz to a synced LFO on BPM change', async () => {
    const { set, spy } = await synth2Engine({ sync: true, div: '1/16' });
    set(['bpm'], 120);
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 8 }) }); // 1/16 @ 120
  });

  it('does NOT re-push a free-mode LFO on BPM change', async () => {
    const { set, spy } = await synth2Engine({ sync: false });
    set(['bpm'], 120);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives the rate when a synced LFO div changes', async () => {
    const { set, spy } = await synth2Engine({ sync: true, div: '1/16' });
    set(['tracks', 0, 'engines', 'synth2', 'lfo1', 'div'], '1/8'); // 0.5 beat @120 → 4 Hz
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 4 }) });
  });

  it('derives the rate when SYNC is turned on', async () => {
    const { set, spy } = await synth2Engine({ sync: false, div: '1/4' });
    set(['tracks', 0, 'engines', 'synth2', 'lfo1', 'sync'], true); // 1 beat @120 → 2 Hz
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 2 }) });
  });

  it('passes the raw Hz through for a free-mode rate edit', async () => {
    const { set, spy } = await synth2Engine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], 3);
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 3 }) });
  });
});

describe('AudioEngine — envelope tempo-sync time derivation', () => {
  async function synth2EnvEngine(env1: Partial<{ sync: boolean; aDiv: string; dDiv: string; rDiv: string; a: number; d: number; r: number }>) {
    const h = makeEngine();
    h.project.bpm = 120;
    h.project.tracks[0].engineType = 'synth2';
    Object.assign(h.project.tracks[0].engines.synth2.env1, env1);
    const state = await h.engine.ensureAudio();
    const spy = vi.spyOn(state.engines[0]!, 'applyParams');
    spy.mockClear();
    return { ...h, state, spy };
  }

  it('re-pushes derived A/D/R seconds to a synced envelope on BPM change', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true }); // divs at defaults 1/2, 2, 4 steps
    set(['bpm'], 120);
    // @120 (step = 125ms): 1/2 step = 62.5ms, 2 steps = 250ms, 4 steps = 500ms
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 0.0625, d: 0.25, r: 0.5 }) });
  });

  it('does NOT re-push a free-mode envelope on BPM change', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: false });
    set(['bpm'], 120);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives times when a synced envelope div changes', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'dDiv'], '1/4'); // quarter step @120 → 31.25ms
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.03125 }) });
  });

  it('derives times when SYNC is turned on', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'sync'], true);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 0.0625, d: 0.25, r: 0.5 }) });
  });

  it('passes raw seconds through for a free-mode a/d/r edit', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'd'], 1.5);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 1.5 }) });
  });

  it('a raw a/d/r write on a SYNCED envelope still reaches audio derived (leaf preserved, derived wins)', async () => {
    const { set, spy, project } = await synth2EnvEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'd'], 5);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.25 }) }); // derived, not 5
    expect(project.tracks[0].engines.synth2.env1.d).toBe(5); // persisted leaf untouched
  });

  it('sustain and loop ride through unchanged when synced', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, dDiv: '2' });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 's'], 0.7);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ s: 0.7, d: 0.25 }) });
  });

  it('clamps the slow extreme: 32 steps @ 40 BPM → 10s ceiling', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, aDiv: '32' });
    set(['bpm'], 40); // 32 steps @40 = 12s pre-clamp
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 10 }) });
  });

  it('falls back to one step for a legacy note-division label', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, dDiv: '1/32T' }); // pre-2026-07-08 label
    set(['bpm'], 120);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.125 }) }); // 1 step @120
  });
});

describe('AudioEngine — glide tempo-sync time derivation', () => {
  async function synth2GlideEngine(glide: Partial<{ sync: boolean; div: string; time: number }>) {
    const h = makeEngine();
    h.project.bpm = 120;
    h.project.tracks[0].engineType = 'synth2';
    Object.assign(h.project.tracks[0].engines.synth2.glide, glide);
    const state = await h.engine.ensureAudio();
    const spy = vi.spyOn(state.engines[0]!, 'applyParams');
    spy.mockClear();
    return { ...h, state, spy };
  }

  it('re-pushes a derived glide time on BPM change (default div "1" = one step)', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: true });
    set(['bpm'], 120);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.125 }) }); // 1 step @120
  });

  it('does NOT re-push a free-mode glide on BPM change', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: false });
    set(['bpm'], 120);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives the time when a synced glide div changes', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'div'], '2'); // 2 steps @120 → 250ms
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.25 }) });
  });

  it('derives the time when SYNC is turned on', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'sync'], true);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.125 }) });
  });

  it('passes raw seconds through for a free-mode time edit', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'time'], 0.3);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.3 }) });
  });

  it('clamps the derived time at the 2s knob ceiling (long division, slow BPM)', async () => {
    const { set, spy } = await synth2GlideEngine({ sync: true, div: '32' }); // 32 steps @40 BPM = 12s
    set(['bpm'], 40);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 2 }) });
  });

  it('a raw time write on a SYNCED glide still reaches audio derived (leaf preserved, derived wins)', async () => {
    const { set, spy, project } = await synth2GlideEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'glide', 'time'], 1.7);
    expect(spy).toHaveBeenCalledWith({ glide: expect.objectContaining({ time: 0.125 }) });
    expect(project.tracks[0].engines.synth2.glide.time).toBe(1.7);
  });
});
