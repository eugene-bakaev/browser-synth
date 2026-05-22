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
  it('should have correct engineType', () => {
    const engine = new ClapEngine();
    expect(engine.engineType).toBe('clap');
  });

  it('should apply params via applyParams without throwing', () => {
    const engine = new ClapEngine();
    expect(() => engine.applyParams({ decay: 0.4, tone: 1500, sloppy: 0.025 })).not.toThrow();
  });

  it('should clamp parameters correctly', () => {
    const engine = new ClapEngine();
    engine.applyParams({ decay: 10, tone: 10000, sloppy: 0.5 });
    expect((engine as any).decay).toBe(0.8);
    expect((engine as any).tone).toBe(3000);
    expect((engine as any).sloppy).toBe(0.03);

    engine.applyParams({ decay: 0.01, tone: 200, sloppy: 0.001 });
    expect((engine as any).decay).toBe(0.05);
    expect((engine as any).tone).toBe(500);
    expect((engine as any).sloppy).toBe(0.005);
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
