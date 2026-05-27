import { describe, it, expect, vi } from 'vitest';
import { KickEngine } from './KickEngine';

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
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);

describe('KickEngine', () => {
  it('should have correct engineType', () => {
    const engine = new KickEngine();
    expect(engine.engineType).toBe('kick');
  });

  it('should apply params via applyParams without throwing', () => {
    const engine = new KickEngine();
    expect(() => engine.applyParams({ tune: 60, decay: 0.5, click: 0.8 })).not.toThrow();
  });

  it('should resume context and trigger pitch/amplitude sweeps', () => {
    const engine = new KickEngine();
    expect(() => engine.trigger(55, 0.3)).not.toThrow();
    expect(engine.ctx.resume).toHaveBeenCalled();
  });

  it('should call stop on oscillator during disposal', () => {
    const engine = new KickEngine();
    engine.trigger(55, 0.3);
    const activeOscs = (engine as any).activeOscs;
    expect(activeOscs.size).toBe(1);
    const mockOsc = Array.from(activeOscs)[0] as any;
    engine.dispose();
    expect(mockOsc.stop).toHaveBeenCalled();
    expect(mockOsc.disconnect).toHaveBeenCalled();
    expect(activeOscs.size).toBe(0);
  });

  it('should scale the gain envelope by velocity', () => {
    const engine = new KickEngine();
    const mockGainNode = new MockGainNode();
    vi.spyOn(engine.ctx, 'createGain').mockReturnValue(mockGainNode as any);
    // Create new engine instance with mock context to trigger createGain mock
    const testEngine = new KickEngine(engine.ctx as any);
    testEngine.trigger(55, 0.3, 0, 0.5);
    expect(mockGainNode.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.5, 0.002);
  });
});
