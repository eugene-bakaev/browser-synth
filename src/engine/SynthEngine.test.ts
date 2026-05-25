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
  setPeriodicWave = vi.fn();
}

class MockBiquadFilterNode extends MockAudioNode {
  type = 'lowpass';
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
}

class MockAudioContext {
  state = 'suspended';
  currentTime = 0;
  destination = new MockAudioNode();
  resume = vi.fn().mockImplementation(() => {
    this.state = 'running';
    return Promise.resolve();
  });
  createGain() { return new MockGainNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  // PhaseOffsetOscillator needs this — setOscMode('phase-offset') in tests
  // calls makeOscillator which goes through createPeriodicWave + setPeriodicWave.
  createPeriodicWave = vi.fn().mockImplementation(() => ({}));
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);

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

  it('setOscMode replaces oscillators on every voice', () => {
    const engine = new SynthEngine();
    const spies = engine.voices.map(v => vi.spyOn(v, 'replaceOscillators'));
    engine.setOscMode('phase-offset');
    spies.forEach(s => expect(s).toHaveBeenCalledTimes(1));
  });

  it('setOscMode is idempotent when called with the current mode', () => {
    const engine = new SynthEngine();
    engine.setOscMode('free-run'); // already the default
    const spies = engine.voices.map(v => vi.spyOn(v, 'replaceOscillators'));
    engine.setOscMode('free-run');
    spies.forEach(s => expect(s).not.toHaveBeenCalled());
  });

  it('applyParams routes oscMode/osc1Phase/osc2Phase to their setters', () => {
    const engine = new SynthEngine();
    const setMode = vi.spyOn(engine, 'setOscMode');
    const setP1 = vi.spyOn(engine, 'setOsc1Phase');
    const setP2 = vi.spyOn(engine, 'setOsc2Phase');
    engine.applyParams({ oscMode: 'phase-offset', osc1Phase: 90, osc2Phase: 270 });
    expect(setMode).toHaveBeenCalledWith('phase-offset');
    expect(setP1).toHaveBeenCalledWith(90);
    expect(setP2).toHaveBeenCalledWith(270);
  });
});
