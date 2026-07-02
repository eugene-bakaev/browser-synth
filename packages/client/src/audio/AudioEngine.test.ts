import { describe, it, expect, vi, beforeEach } from 'vitest';
import { reactive, nextTick } from 'vue';
import { freshProject, type Project } from '../project';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

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
  return { project, engine: new AudioEngine({ project }) };
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

  it('forwards only the changed key when one active-engine param is mutated', async () => {
    const { project, engine } = makeEngine();
    const state = await engine.ensureAudio();
    const applySpy = vi.spyOn(state.engines[0]!, 'applyParams');
    applySpy.mockClear();

    project.tracks[0].engines.synth.filterCutoff = 1234;
    await nextTick();

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
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
