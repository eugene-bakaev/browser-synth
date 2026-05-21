import { describe, it, expect, vi } from 'vitest';
import { ClapEngine } from './ClapEngine';

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  context = { currentTime: 0 };
}

class MockAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
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
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  type = 'lowpass';
}

class MockAudioBuffer {
  getChannelData = vi.fn().mockReturnValue(new Float32Array(100));
}

class MockAudioBufferSourceNode extends MockAudioNode {
  buffer = null;
  loop = false;
  start = vi.fn();
  stop = vi.fn();
  onended = null;
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
  createBufferSource() { return new MockAudioBufferSourceNode(); }
  createBuffer() { return new MockAudioBuffer(); }
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);

describe('ClapEngine', () => {
  it('should initialize nodes and default values', () => {
    const engine = new ClapEngine();
    expect(engine.decay).toBe(0.25);
    expect(engine.tone).toBe(1000);
    expect(engine.sloppy).toBe(0.015);
  });

  it('should allow setting parameters', () => {
    const engine = new ClapEngine();
    engine.setDecay(0.4);
    engine.setTone(1500);
    engine.setSloppy(0.025);
    expect(engine.decay).toBe(0.4);
    expect(engine.tone).toBe(1500);
    expect(engine.sloppy).toBe(0.025);
  });

  it('should resume context and trigger clap envelope spikes', () => {
    const engine = new ClapEngine();
    expect(() => engine.trigger(440, 0.25)).not.toThrow();
    expect(engine.ctx.resume).toHaveBeenCalled();
  });

  it('should dispose correctly', () => {
    const engine = new ClapEngine();
    expect(() => engine.dispose()).not.toThrow();
  });
});
