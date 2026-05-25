import { describe, it, expect, vi } from 'vitest';
import { PhaseOffsetOscillator } from './PhaseOffsetOscillator';

class MockAudioParam {
  value = 0;
  setValueAtTime = vi.fn();
}
class MockOscillatorNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type: OscillatorType = 'sine';
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
  setPeriodicWave = vi.fn();
  context = { currentTime: 0 };
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createPeriodicWave = vi.fn().mockImplementation((real: Float32Array, imag: Float32Array) => ({ real, imag }));
  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('PhaseOffsetOscillator', () => {
  it('applies a PeriodicWave on construction and start()s the osc', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    expect(ctx.createPeriodicWave).toHaveBeenCalledTimes(1);
    expect((osc as any).osc.setPeriodicWave).toHaveBeenCalledTimes(1);
    expect((osc as any).osc.start).toHaveBeenCalledTimes(1);
  });

  it('setWaveform rebuilds the PeriodicWave', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    ctx.createPeriodicWave.mockClear();
    osc.setWaveform('square');
    expect(ctx.createPeriodicWave).toHaveBeenCalledTimes(1);
    expect((osc as any).osc.setPeriodicWave).toHaveBeenCalled();
  });

  it('setPhase rebuilds the PeriodicWave with rotated coefficients', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    ctx.createPeriodicWave.mockClear();
    osc.setPhase(90);
    expect(ctx.createPeriodicWave).toHaveBeenCalledTimes(1);
    // The rotated arrays passed should differ from the phase=0 baseline.
    const [real, imag] = ctx.createPeriodicWave.mock.calls[0];
    expect(real).toBeInstanceOf(Float32Array);
    expect(imag).toBeInstanceOf(Float32Array);
    // For sawtooth at 90°, imag[1] is not equal to the unrotated value.
    expect(imag[1]).not.toBe(2 / Math.PI);
  });

  it('setPhase wraps negative and >360 inputs into [0, 360)', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    osc.setPhase(-90);
    expect((osc as any).phaseDeg).toBe(270);
    osc.setPhase(450);
    expect((osc as any).phaseDeg).toBe(90);
  });

  it('triggerAt delegates to setFrequencyAtTime', () => {
    const ctx = new (AudioContext as any)();
    const osc = new PhaseOffsetOscillator(ctx);
    const spy = vi.spyOn(osc, 'setFrequencyAtTime');
    osc.triggerAt(220, 0.5, 99);
    expect(spy).toHaveBeenCalledWith(220, 0.5);
  });
});
