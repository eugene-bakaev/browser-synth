import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SynthEngine } from './SynthEngine';

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
}

class MockGainNode extends MockAudioNode {
  gain = new MockAudioParam();
}

class MockOscillatorNode extends MockAudioNode {
  frequency = new MockAudioParam();
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
  it('should initialize all modules', () => {
    const engine = new SynthEngine();
    expect(engine.osc1).toBeDefined();
    expect(engine.osc2).toBeDefined();
    expect(engine.mixer).toBeDefined();
    expect(engine.filter).toBeDefined();
    expect(engine.ampEnv).toBeDefined();
    expect(engine.filterEnv).toBeDefined();
  });

  it('should trigger a note', () => {
    const engine = new SynthEngine();
    const freq = 440;
    const duration = 0.5;
    
    expect(() => engine.trigger(freq, duration)).not.toThrow();
  });

  it('should resume context if suspended', () => {
    const engine = new SynthEngine();
    engine.trigger(440, 0.5);
    expect(engine.ctx.resume).toHaveBeenCalled();
  });
});
