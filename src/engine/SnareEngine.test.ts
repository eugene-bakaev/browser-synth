import { describe, it, expect, vi } from 'vitest';
import { SnareEngine } from './SnareEngine';

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

describe('SnareEngine', () => {
  it('should have correct engineType', () => {
    const engine = new SnareEngine();
    expect(engine.engineType).toBe('snare');
  });

  it('should apply params via applyParams without throwing', () => {
    const engine = new SnareEngine();
    expect(() => engine.applyParams({ tune: 200, decay: 0.4, snappy: 0.8 })).not.toThrow();
  });

  it('should resume context and trigger body/wires sweeps', () => {
    const engine = new SnareEngine();
    expect(() => engine.trigger(180, 0.25)).not.toThrow();
    expect(engine.ctx.resume).toHaveBeenCalled();
  });

  it('should dispose correctly', () => {
    const engine = new SnareEngine();
    const mockOsc = (engine as any).bodyOsc;
    engine.dispose();
    expect(mockOsc.stop).toHaveBeenCalled();
    expect(mockOsc.disconnect).toHaveBeenCalled();
  });
});
