import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  context = { currentTime: 0 };
}

class MockAudioParam {
  value = 0.8;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn().mockImplementation((val) => {
    this.value = val;
  });
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

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
  resonance = new MockAudioParam(); // Support resonance access as AudioParam if needed
  type = 'lowpass';
}

class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam();
  knee = new MockAudioParam();
  ratio = new MockAudioParam();
  attack = new MockAudioParam();
  release = new MockAudioParam();
}

class MockAnalyserNode extends MockAudioNode {
  fftSize = 1024;
}

class MockAudioWorkletNode extends MockAudioNode {
  parameters = new Map<string, MockAudioParam>([
    ['frequency',  new MockAudioParam()],
    ['detune',     new MockAudioParam()],
    ['pulseWidth', new MockAudioParam()],
  ]);
}

class MockAudioContext {
  state = 'suspended';
  currentTime = 0;
  sampleRate = 44100;
  destination = new MockAudioNode();
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockImplementation(() => {
    this.state = 'running';
    return Promise.resolve();
  });
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

// Mirrors AudioEngine.sliderToLinearGain — slider 0..1 → -54..+6 dB → linear gain.
// Same math, so the floating-point result matches bit-for-bit.
const sliderGain = (s: number) => s <= 0 ? 0 : Math.pow(10, (-54 + s * 60) / 20);

let trackGains: any[];

describe('TrackMixer Logic', () => {
  let runtime: any;
  let synthData: any;
  let mod: { dispatchLocal: (path: any, value: any) => void };

  beforeEach(async () => {
    // Fresh runtime + context per test (Phase 5: replaces the useSynth module
    // singletons). Mixer tests don't exercise the WS layer — keep it dark so
    // ensureAudio() doesn't try to resolve a room / open a socket (no `window`
    // in node env).
    const { createAppRuntime } = await import('../app/AppRuntime');
    const { createSynthContext } = await import('../app/synthContext');
    runtime = createAppRuntime({ syncEnabled: false });
    synthData = createSynthContext(runtime);
    mod = { dispatchLocal: synthData.dispatchLocal };
    // Audio state is lazy now — force it up so trackGains exist + the bus
    // stream subscription is live. Bootstrap is async because of the pulse
    // worklet's addModule step.
    await synthData.ensureAudio();
    trackGains = synthData.trackGains.value;

    // Reset project.tracks to defaults through the bus — a direct mutation no
    // longer reaches audio (watchers gone; reactions ride the command stream).
    // Slider is 0..1 (perceptual); the gain node receives sliderGain(slider)
    // after the U4 log-scale conversion.
    synthData.project.tracks.forEach((_track: any, i: number) => {
      mod.dispatchLocal(['tracks', i, 'mixer', 'volume'], 0.8);
      mod.dispatchLocal(['tracks', i, 'mixer', 'muted'], false);
      mod.dispatchLocal(['tracks', i, 'mixer', 'soloed'], false);
    });
    // Reset spy call records + mock gain.value to the new expected baseline.
    // Disabled pool slots are gated to silence regardless of mixer volume.
    trackGains.forEach((g: any, i: number) => {
      g.gain.setTargetAtTime.mockClear();
      g.gain.value = synthData.project.tracks[i].enabled ? sliderGain(0.8) : 0;
    });
  });

  // Full teardown per test: settles fade-dispose timers + closes the (mock) ctx
  // so nothing outlives the stubbed globals.
  afterEach(() => { runtime?.shutdown(); runtime = null; });

  it('should initialize the full pool: enabled slots at default gain, disabled slots silent', () => {
    expect(trackGains.length).toBe(TRACK_POOL_SIZE);
    trackGains.forEach((g: any, i: number) => {
      // freshProject enables the first DEFAULT_ENABLED_TRACKS slots; the rest of
      // the 32-slot pool is disabled and gated to silence by updateMixerGains.
      const expected = synthData.project.tracks[i].enabled ? sliderGain(0.8) : 0;
      expect(g.gain.value).toBe(expected);
    });
  });

  it('should apply volume changes smoothly to gain nodes', async () => {
    // Modify volume on track 0
    mod.dispatchLocal(['tracks', 0, 'mixer', 'volume'], 0.5);

    // Wait for Vue's watch/reactive effect cycle
    await vi.waitFor(() => {
      expect(trackGains[0].gain.setTargetAtTime).toHaveBeenCalledWith(sliderGain(0.5), expect.any(Number), 0.015);
    });
    expect(trackGains[0].gain.value).toBe(sliderGain(0.5));
  });

  it('should mute a track correctly by setting gain to 0', async () => {
    // Mute track 1
    mod.dispatchLocal(['tracks', 1, 'mixer', 'muted'], true);

    await vi.waitFor(() => {
      expect(trackGains[1].gain.setTargetAtTime).toHaveBeenCalledWith(0, expect.any(Number), 0.015);
    });
    expect(trackGains[1].gain.value).toBe(0);
    // Track 0 should remain at its volume
    expect(trackGains[0].gain.value).toBe(sliderGain(0.8));
  });

  it('should solo a track and silence all other non-soloed tracks', async () => {
    // Solo track 2
    mod.dispatchLocal(['tracks', 2, 'mixer', 'soloed'], true);

    await vi.waitFor(() => {
      // Soloed track should remain at its volume
      expect(trackGains[2].gain.value).toBe(sliderGain(0.8));
      // Others should be silenced
      expect(trackGains[0].gain.value).toBe(0);
      expect(trackGains[1].gain.value).toBe(0);
      expect(trackGains[3].gain.value).toBe(0);
    });
  });

  it('should support multiple soloed tracks simultaneously', async () => {
    // Solo track 0 and 2
    mod.dispatchLocal(['tracks', 0, 'mixer', 'soloed'], true);
    mod.dispatchLocal(['tracks', 2, 'mixer', 'soloed'], true);

    await vi.waitFor(() => {
      expect(trackGains[0].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[2].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[1].gain.value).toBe(0);
      expect(trackGains[3].gain.value).toBe(0);
    });
  });

  it('should respect mute on a soloed track', async () => {
    // Solo track 0, but also mute it
    mod.dispatchLocal(['tracks', 0, 'mixer', 'soloed'], true);
    mod.dispatchLocal(['tracks', 0, 'mixer', 'muted'], true);

    await vi.waitFor(() => {
      // Even though track 0 is soloed, it is muted so gain should be 0
      expect(trackGains[0].gain.value).toBe(0);
      // Other tracks are not soloed, so they are silenced too
      expect(trackGains[1].gain.value).toBe(0);
    });
  });

  it('should restore all track volumes when solo is turned off', async () => {
    // First solo track 3
    mod.dispatchLocal(['tracks', 3, 'mixer', 'soloed'], true);
    await vi.waitFor(() => {
      expect(trackGains[0].gain.value).toBe(0);
      expect(trackGains[3].gain.value).toBe(sliderGain(0.8));
    });

    // Unsolo track 3
    mod.dispatchLocal(['tracks', 3, 'mixer', 'soloed'], false);
    await vi.waitFor(() => {
      // All tracks should return to their regular volume
      expect(trackGains[0].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[1].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[2].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[3].gain.value).toBe(sliderGain(0.8));
    });
  });
});
