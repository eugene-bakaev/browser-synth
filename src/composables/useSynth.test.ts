import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { nextTick } from 'vue';

// Same minimal Web Audio mock as TrackMixer.test — useSynth touches AudioContext
// transitively via ensureAudio().
class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  context = { currentTime: 0 };
}
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
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type = 'sine';
  start = vi.fn();
  stop = vi.fn();
}
class MockBiquadFilterNode extends MockAudioNode {
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  type = 'lowpass';
}
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam();
  knee = new MockAudioParam();
  ratio = new MockAudioParam();
  attack = new MockAudioParam();
  release = new MockAudioParam();
}
class MockAnalyserNode extends MockAudioNode { fftSize = 1024; }
class MockAudioContext {
  state = 'suspended';
  currentTime = 0;
  sampleRate = 44100;
  destination = new MockAudioNode();
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockImplementation(() => { this.state = 'running'; return Promise.resolve(); });
  createGain() { return new MockGainNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);

let useSynth: any;
let disposeSynth: any;

describe('useSynth narrow watchers (A2)', () => {
  beforeAll(async () => {
    const mod = await import('./useSynth');
    useSynth = mod.useSynth;
    disposeSynth = mod.disposeSynth;
  });

  beforeEach(() => {
    // Reset audio state between tests so each gets a fresh engine to spy on.
    disposeSynth();
  });

  it('forwards only the changed key when one synth param is mutated', async () => {
    const synth = useSynth();
    const state = synth.ensureAudio();
    const engine = state.engines[0];
    const applySpy = vi.spyOn(engine, 'applyParams');
    applySpy.mockClear();

    synth.trackStates[0].synth.filterCutoff = 1234;
    await nextTick();

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
  });

  it('forwards the full ADSR object when an envelope leaf is mutated', async () => {
    const synth = useSynth();
    const state = synth.ensureAudio();
    const engine = state.engines[0];
    const applySpy = vi.spyOn(engine, 'applyParams');
    applySpy.mockClear();

    synth.trackStates[0].synth.filterEnv.a = 0.123;
    await nextTick();

    // ADSR objects are passed whole to applyParams (engine setter takes a/d/s/r
    // together) — but only the filterEnv key, not the other 12 synth params.
    expect(applySpy).toHaveBeenCalledTimes(1);
    const call = applySpy.mock.calls[0][0] as Record<string, any>;
    expect(Object.keys(call)).toEqual(['filterEnv']);
    expect(call.filterEnv).toMatchObject({ a: 0.123 });
  });

  it('skips applyParams when an inactive engine slice changes', async () => {
    const synth = useSynth();
    const state = synth.ensureAudio();
    const synthEngine = state.engines[0]; // track 0 starts as synth
    const applySpy = vi.spyOn(synthEngine, 'applyParams');
    applySpy.mockClear();

    // Mutate the kick slice on track 0 while engineType is still 'synth'.
    synth.trackStates[0].kick.tune = 80;
    await nextTick();

    expect(applySpy).not.toHaveBeenCalled();
  });
});
