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
    engine.trigger(180, 0.25);
    const activeOscs = (engine as any).activeOscs;
    expect(activeOscs.size).toBe(1);
    const mockOsc = Array.from(activeOscs)[0] as any;
    engine.dispose();
    expect(mockOsc.stop).toHaveBeenCalled();
    expect(mockOsc.disconnect).toHaveBeenCalled();
    expect(activeOscs.size).toBe(0);
  });

  it('should scale the body and noise envelopes by velocity', () => {
    const engine = new SnareEngine();
    const g1 = new MockGainNode(); // body
    const g2 = new MockGainNode(); // noise
    const g3 = new MockGainNode(); // master
    vi.spyOn(engine.ctx, 'createGain')
      .mockReturnValueOnce(g1 as any)
      .mockReturnValueOnce(g2 as any)
      .mockReturnValueOnce(g3 as any);

    const testEngine = new SnareEngine(engine.ctx as any);
    testEngine.applyParams({ snappy: 0.5 });
    testEngine.trigger(180, 0.25, 0, 0.5);

    // bodyMaxGain = (1.0 - 0.5) * 1.2 * 0.5 = 0.3
    // noiseMaxGain = 0.5 * 1.5 * 0.5 = 0.375
    expect(g1.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.3, 0.002);
    expect(g2.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.375, 0.002);
  });
});
