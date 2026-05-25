import { describe, it, expect, vi } from 'vitest';
import { RetriggerOscillator } from './RetriggerOscillator';

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
}
class MockOscillatorNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  setPeriodicWave = vi.fn();
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createOscillator = vi.fn().mockImplementation(() => new MockOscillatorNode());
  createGain = vi.fn().mockImplementation(() => new MockGainNode());
  createPeriodicWave = vi.fn().mockImplementation((real: Float32Array, imag: Float32Array) => ({ real, imag }));
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('RetriggerOscillator', () => {
  it('does not create an oscillator at construction', () => {
    const ctx = new (AudioContext as any)();
    new RetriggerOscillator(ctx);
    expect(ctx.createOscillator).not.toHaveBeenCalled();
  });

  it('triggerAt creates a fresh osc, sets the rotated PeriodicWave, and schedules start+stop', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.triggerAt(440, 1.0, 1.5);

    expect(ctx.createOscillator).toHaveBeenCalledTimes(1);
    const created = ctx.createOscillator.mock.results[0].value as any;
    expect(created.setPeriodicWave).toHaveBeenCalledTimes(1);
    expect(created.frequency.setValueAtTime).toHaveBeenCalledWith(440, 1.0);
    expect(created.start).toHaveBeenCalledWith(1.0);
    expect(created.stop).toHaveBeenCalledWith(1.55);
  });

  it('two consecutive triggerAt calls create two distinct osc nodes', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.triggerAt(440, 0, 0.5);
    osc.triggerAt(523, 0.5, 1.0);
    expect(ctx.createOscillator).toHaveBeenCalledTimes(2);
  });

  it('setPhase between triggers affects only subsequent triggers', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.triggerAt(440, 0, 0.5);
    const firstPhase = ctx.createPeriodicWave.mock.calls[0];
    osc.setPhase(90);
    osc.triggerAt(440, 0.5, 1.0);
    const secondPhase = ctx.createPeriodicWave.mock.calls[1];
    expect(firstPhase[1][1]).not.toBe(secondPhase[1][1]);
  });

  it('coarseTune is applied at trigger time', () => {
    const ctx = new (AudioContext as any)();
    const osc = new RetriggerOscillator(ctx);
    osc.setCoarseTune(1); // +1 octave
    osc.triggerAt(440, 0, 0.5);
    const created = ctx.createOscillator.mock.results[0].value as any;
    expect(created.frequency.setValueAtTime).toHaveBeenCalledWith(880, 0);
  });
});
