import { describe, it, expect, vi } from 'vitest';
import { HatEngine } from './HatEngine';

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

describe('HatEngine', () => {
  it('should have correct engineType', () => {
    const engine = new HatEngine();
    expect(engine.engineType).toBe('hat');
  });

  it('should apply params via applyParams without throwing', () => {
    const engine = new HatEngine();
    expect(() => engine.applyParams({ decay: 0.3, tone: 10000, metallic: 0.8 })).not.toThrow();
  });

  it('should resume context and trigger sweeps', () => {
    const engine = new HatEngine();
    expect(() => engine.trigger(440, 0.1)).not.toThrow();
    expect(engine.ctx.resume).toHaveBeenCalled();
  });

  it('should dispose correctly', () => {
    const engine = new HatEngine();
    engine.trigger(440, 0.1);
    const activeOscs = (engine as any).activeOscs;
    expect(activeOscs.size).toBe(6);
    const mockOscs = Array.from(activeOscs);
    engine.dispose();
    mockOscs.forEach((osc: any) => {
      expect(osc.stop).toHaveBeenCalled();
      expect(osc.disconnect).toHaveBeenCalled();
    });
    expect(activeOscs.size).toBe(0);
  });
});
