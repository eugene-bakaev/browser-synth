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
      filterEnvAmount: 5000,
      filterEnv: { a: 0.05, d: 0.3, s: 0.4, r: 0.6 },
      ampEnv: { a: 0.02, d: 0.1, s: 0.8, r: 0.3 },
    })).not.toThrow();
  });

  it('should clamp parameters correctly including cutoff up to 20000', () => {
    const engine = new SynthEngine();
    engine.applyParams({ filterCutoff: 30000 });
    expect((engine as any).baseCutoff).toBe(20000);

    engine.applyParams({ filterCutoff: 10 });
    expect((engine as any).baseCutoff).toBe(20);
  });

  it('should dispose without throwing', () => {
    const engine = new SynthEngine();
    expect(() => engine.dispose()).not.toThrow();
  });
});
