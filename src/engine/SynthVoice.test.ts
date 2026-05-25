import { describe, it, expect, vi } from 'vitest';

// Minimal Web Audio mocks — same pattern as SynthEngine.test.ts.
// All AudioNode-like mocks extend a single base class that is stubbed in for
// the global AudioNode so `instanceof AudioNode` guards inside SynthVoice +
// PatchBay see truthy values.
class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  context = { currentTime: 0 };
}

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class MockOscillatorNode extends MockAudioNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type: OscillatorType = 'sine';
  start = vi.fn();
  stop = vi.fn();
  setPeriodicWave = vi.fn();
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
}

class MockAudioContext {
  currentTime = 0;
  destination = new MockAudioNode();
  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createPeriodicWave = vi.fn().mockImplementation(() => ({}));
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);

import { SynthVoice } from './SynthVoice';

describe('SynthVoice', () => {
  it('replaceOscillators disposes the old osc1/osc2 and rewires new ones', () => {
    const ctx = new (AudioContext as any)();
    const dest = new MockGainNode();
    const voice = new SynthVoice(ctx as any, dest as any);

    const oldOsc1 = voice.osc1;
    const oldOsc2 = voice.osc2;
    const dispose1 = vi.spyOn(oldOsc1, 'dispose');
    const dispose2 = vi.spyOn(oldOsc2, 'dispose');

    voice.replaceOscillators('phase-offset', {
      osc1Type: 'sawtooth',
      osc2Type: 'sawtooth',
      osc1Coarse: 0,
      osc1Fine: 0,
      osc2Coarse: 0,
      osc2Fine: 0,
      osc1Phase: 0,
      osc2Phase: 0,
    });

    expect(dispose1).toHaveBeenCalled();
    expect(dispose2).toHaveBeenCalled();
    expect(voice.osc1).not.toBe(oldOsc1);
    expect(voice.osc2).not.toBe(oldOsc2);
  });
});
