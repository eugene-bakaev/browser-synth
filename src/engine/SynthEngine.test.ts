import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SynthEngine } from './SynthEngine';

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
  setTargetAtTime = vi.fn();
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
  type = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
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
  destination = new MockAudioNode();
  // OscillatorModule constructs `new AudioWorkletNode(ctx, 'pulse')` in its
  // ctor. We don't await addModule here (these tests bypass useSynth's async
  // bootstrap and go straight to `new SynthEngine()`), so the mock just lets
  // node construction succeed.
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  resume = vi.fn().mockImplementation(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  createGain() { return new MockGainNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

describe('SynthEngine', () => {
  it('should have correct engineType', () => {
    const engine = new SynthEngine();
    expect(engine.engineType).toBe('synth');
  });

  it('should trigger a note without throwing', () => {
    const engine = new SynthEngine();
    expect(() => engine.trigger(440, 0.5)).not.toThrow();
  });

  it('should trigger a chord without throwing', () => {
    const engine = new SynthEngine();
    expect(() => engine.trigger([261.63, 329.63, 392.00], 0.5)).not.toThrow();
  });

  it('should resume context if suspended', () => {
    const engine = new SynthEngine();
    engine.trigger(440, 0.5);
    expect(engine.ctx.resume).toHaveBeenCalled();
  });

  it('should apply params via applyParams without throwing', () => {
    const engine = new SynthEngine();
    expect(() => engine.applyParams({
      osc1Type: 'square',
      osc2Type: 'triangle',
      osc1Coarse: 1,
      osc1Fine: 5,
      filterCutoff: 3000,
      filterRes: 2,
      filterEnvAmount: 1.0,
      filterEnv: { a: 0.05, d: 0.3, s: 0.4, r: 0.6 },
      ampEnv: { a: 0.02, d: 0.1, s: 0.8, r: 0.3 },
    })).not.toThrow();
  });

  it('should clamp filterEnvAmount to the bipolar ±4 octave range', () => {
    const engine = new SynthEngine();

    // Mid-range values pass through
    engine.applyParams({ filterEnvAmount: 2.4 });
    expect((engine as any).filterEnvAmount).toBe(2.4);

    // Negative values are allowed (downward sweep)
    engine.applyParams({ filterEnvAmount: -2.0 });
    expect((engine as any).filterEnvAmount).toBe(-2.0);

    // Clamps to +4 octaves upper bound
    engine.applyParams({ filterEnvAmount: 10 });
    expect((engine as any).filterEnvAmount).toBe(4);

    // Clamps to -4 octaves lower bound
    engine.applyParams({ filterEnvAmount: -10 });
    expect((engine as any).filterEnvAmount).toBe(-4);

    // Neutral (no envelope effect on cutoff)
    engine.applyParams({ filterEnvAmount: 0 });
    expect((engine as any).filterEnvAmount).toBe(0);
  });

  it('should produce a downward filter sweep when filterEnvAmount is negative', () => {
    const engine = new SynthEngine();
    engine.applyParams({ filterCutoff: 2000, filterEnvAmount: -2 });

    const voice = engine.voices[0];
    const filterEnvSpy = vi.spyOn(voice.filterEnv, 'trigger');

    engine.trigger(440, 0.5, 0);

    // Voice should drive its filter envelope from baseCutoff (2000) down to
    // 2000 * 2^(-2) = 500Hz — a clear downward sweep target.
    expect(filterEnvSpy).toHaveBeenCalled();
    const [, , , min, max] = filterEnvSpy.mock.calls[0];
    expect(min).toBe(2000);
    expect(max).toBeCloseTo(500, 1);
  });

  it('should clamp parameters correctly including cutoff up to 20000', () => {
    const engine = new SynthEngine();
    engine.applyParams({ filterCutoff: 30000 });
    expect((engine as any).baseCutoff).toBe(20000);

    engine.applyParams({ filterCutoff: 10 });
    expect((engine as any).baseCutoff).toBe(20);
  });

  it('should accept and forward velocity to the active voice', () => {
    const engine = new SynthEngine();
    const voice = engine.voices[0];
    const voiceSpy = vi.spyOn(voice, 'trigger');

    engine.trigger(440, 0.5, 0, 0.42);
    expect(voiceSpy).toHaveBeenCalledWith(440, 0.5, 0, 0.42);
  });

  it('should default velocity to 1.0 when omitted', () => {
    const engine = new SynthEngine();
    const voice = engine.voices[0];
    const voiceSpy = vi.spyOn(voice, 'trigger');

    engine.trigger(440, 0.5);
    expect(voiceSpy).toHaveBeenCalledWith(440, 0.5, expect.any(Number), 1.0);
  });

  it('mono triggers (single freq) always reuse voice[0] so cancelAndHold steals the prior note', () => {
    const engine = new SynthEngine();
    const v0Spy = vi.spyOn(engine.voices[0], 'trigger');
    const v1Spy = vi.spyOn(engine.voices[1], 'trigger');

    engine.trigger(440, 0.5, 0);
    engine.trigger(523.25, 0.5, 0.25);
    engine.trigger(659.25, 0.5, 0.5);

    expect(v0Spy).toHaveBeenCalledTimes(3);
    expect(v1Spy).not.toHaveBeenCalled();
  });

  it('poly triggers (array of freqs) round-robin across voices', () => {
    const engine = new SynthEngine();
    const v0Spy = vi.spyOn(engine.voices[0], 'trigger');
    const v1Spy = vi.spyOn(engine.voices[1], 'trigger');
    const v2Spy = vi.spyOn(engine.voices[2], 'trigger');

    engine.trigger([261.63, 329.63, 392.00], 0.5, 0);

    expect(v0Spy).toHaveBeenCalledTimes(1);
    expect(v1Spy).toHaveBeenCalledTimes(1);
    expect(v2Spy).toHaveBeenCalledTimes(1);
  });

  it('should write filterCutoff to the live AudioParam so the knob affects sustaining notes', () => {
    const engine = new SynthEngine();
    const voice = engine.voices[0];
    const cutoffParam = voice.filter.inputs.cutoff as any;
    cutoffParam.setTargetAtTime.mockClear();

    engine.applyParams({ filterCutoff: 1234 });

    expect(cutoffParam.setTargetAtTime).toHaveBeenCalledWith(1234, expect.any(Number), 0.01);
  });

  it('should dispose without throwing', () => {
    const engine = new SynthEngine();
    expect(() => engine.dispose()).not.toThrow();
  });

  it('clamps pulse width to [0.05, 0.95] and routes osc1/osc2 independently', () => {
    const engine = new SynthEngine();
    engine.applyParams({ osc1PulseWidth: 0.3, osc2PulseWidth: 0.7 });
    expect((engine as any).osc1PulseWidth).toBeCloseTo(0.3, 5);
    expect((engine as any).osc2PulseWidth).toBeCloseTo(0.7, 5);

    engine.applyParams({ osc1PulseWidth: 0 });
    expect((engine as any).osc1PulseWidth).toBe(0.05);

    engine.applyParams({ osc1PulseWidth: 1 });
    expect((engine as any).osc1PulseWidth).toBe(0.95);
  });

  it('routes pulseWidth to the AudioWorkletNode pulseWidth AudioParam', () => {
    const engine = new SynthEngine();
    const oscModule = engine.voices[0].osc1 as any;
    const pw = oscModule.pulseNode.parameters.get('pulseWidth') as any;
    pw.setValueAtTime.mockClear();

    engine.applyParams({ osc1PulseWidth: 0.25 });

    expect(pw.setValueAtTime).toHaveBeenCalledWith(0.25, expect.any(Number));
  });

  it("setWaveform('square') hot-swaps the gain input from native osc to worklet node", () => {
    const engine = new SynthEngine();
    const oscModule = engine.voices[0].osc1 as any;
    oscModule.nativeOsc.disconnect.mockClear();
    oscModule.pulseNode.connect.mockClear();

    engine.applyParams({ osc1Type: 'square' });

    expect(oscModule.nativeOsc.disconnect).toHaveBeenCalled();
    expect(oscModule.pulseNode.connect).toHaveBeenCalledWith(oscModule.gain);
    expect((oscModule as any).active).toBe('pulse');
  });

  it("setWaveform back to a non-square type swaps the gain input back to native osc", () => {
    const engine = new SynthEngine();
    const oscModule = engine.voices[0].osc1 as any;
    engine.applyParams({ osc1Type: 'square' });
    oscModule.pulseNode.disconnect.mockClear();
    oscModule.nativeOsc.connect.mockClear();

    engine.applyParams({ osc1Type: 'sawtooth' });

    expect(oscModule.pulseNode.disconnect).toHaveBeenCalled();
    expect(oscModule.nativeOsc.connect).toHaveBeenCalledWith(oscModule.gain);
    expect(oscModule.nativeOsc.type).toBe('sawtooth');
    expect((oscModule as any).active).toBe('native');
  });

  it('fans out setFrequencyAtTime to both native osc and worklet so mid-note waveform swaps keep pitch', () => {
    const engine = new SynthEngine();
    const oscModule = engine.voices[0].osc1 as any;
    oscModule.nativeOsc.frequency.setValueAtTime.mockClear();
    const pulseFreq = oscModule.pulseNode.parameters.get('frequency') as any;
    pulseFreq.setValueAtTime.mockClear();

    engine.trigger(523.25, 0.5, 0);

    expect(oscModule.nativeOsc.frequency.setValueAtTime).toHaveBeenCalledWith(523.25, 0);
    expect(pulseFreq.setValueAtTime).toHaveBeenCalledWith(523.25, 0);
  });
});
