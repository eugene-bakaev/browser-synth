import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

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

class MockAudioContext {
  state = 'suspended';
  currentTime = 0;
  sampleRate = 44100;
  destination = new MockAudioNode();
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

// Mirrors useSynth.sliderToLinearGain — slider 0..1 → -54..+6 dB → linear gain.
// Same math, so the floating-point result matches bit-for-bit.
const sliderGain = (s: number) => s <= 0 ? 0 : Math.pow(10, (-54 + s * 60) / 20);

let useSynth: any;
let trackGains: any[];

describe('TrackMixer Logic', () => {
  let synthData: any;

  beforeAll(async () => {
    const mod = await import('../composables/useSynth');
    useSynth = mod.useSynth;
  });

  beforeEach(() => {
    synthData = useSynth();
    // Audio state is lazy now — force it up so trackGains exist + watchers are live.
    synthData.ensureAudio();
    trackGains = synthData.trackGains.value;

    // Reset project.tracks to defaults. Slider is 0..1 (perceptual); the gain
    // node receives sliderGain(slider) after the U4 log-scale conversion.
    synthData.project.tracks.forEach((track: any) => {
      track.mixer.volume = 0.8;
      track.mixer.muted = false;
      track.mixer.soloed = false;
    });
    // Reset spy call records + mock gain.value to the new expected baseline.
    trackGains.forEach((g: any) => {
      g.gain.setTargetAtTime.mockClear();
      g.gain.value = sliderGain(0.8);
    });
  });

  it('should initialize tracks with default volume gain', () => {
    expect(trackGains.length).toBe(4);
    trackGains.forEach((g: any) => {
      expect(g.gain.value).toBe(sliderGain(0.8));
    });
  });

  it('should apply volume changes smoothly to gain nodes', async () => {
    // Modify volume on track 0
    synthData.project.tracks[0].mixer.volume = 0.5;

    // Wait for Vue's watch/reactive effect cycle
    await vi.waitFor(() => {
      expect(trackGains[0].gain.setTargetAtTime).toHaveBeenCalledWith(sliderGain(0.5), expect.any(Number), 0.015);
    });
    expect(trackGains[0].gain.value).toBe(sliderGain(0.5));
  });

  it('should mute a track correctly by setting gain to 0', async () => {
    // Mute track 1
    synthData.project.tracks[1].mixer.muted = true;

    await vi.waitFor(() => {
      expect(trackGains[1].gain.setTargetAtTime).toHaveBeenCalledWith(0, expect.any(Number), 0.015);
    });
    expect(trackGains[1].gain.value).toBe(0);
    // Track 0 should remain at its volume
    expect(trackGains[0].gain.value).toBe(sliderGain(0.8));
  });

  it('should solo a track and silence all other non-soloed tracks', async () => {
    // Solo track 2
    synthData.project.tracks[2].mixer.soloed = true;

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
    synthData.project.tracks[0].mixer.soloed = true;
    synthData.project.tracks[2].mixer.soloed = true;

    await vi.waitFor(() => {
      expect(trackGains[0].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[2].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[1].gain.value).toBe(0);
      expect(trackGains[3].gain.value).toBe(0);
    });
  });

  it('should respect mute on a soloed track', async () => {
    // Solo track 0, but also mute it
    synthData.project.tracks[0].mixer.soloed = true;
    synthData.project.tracks[0].mixer.muted = true;

    await vi.waitFor(() => {
      // Even though track 0 is soloed, it is muted so gain should be 0
      expect(trackGains[0].gain.value).toBe(0);
      // Other tracks are not soloed, so they are silenced too
      expect(trackGains[1].gain.value).toBe(0);
    });
  });

  it('should restore all track volumes when solo is turned off', async () => {
    // First solo track 3
    synthData.project.tracks[3].mixer.soloed = true;
    await vi.waitFor(() => {
      expect(trackGains[0].gain.value).toBe(0);
      expect(trackGains[3].gain.value).toBe(sliderGain(0.8));
    });

    // Unsolo track 3
    synthData.project.tracks[3].mixer.soloed = false;
    await vi.waitFor(() => {
      // All tracks should return to their regular volume
      expect(trackGains[0].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[1].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[2].gain.value).toBe(sliderGain(0.8));
      expect(trackGains[3].gain.value).toBe(sliderGain(0.8));
    });
  });
});
