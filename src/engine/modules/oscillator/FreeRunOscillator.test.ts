import { describe, it, expect, vi } from 'vitest';
import { FreeRunOscillator } from './FreeRunOscillator';

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
  context = { currentTime: 0 };
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  createOscillator() { return new MockOscillatorNode(); }
  createGain() { return new MockGainNode(); }
}
vi.stubGlobal('AudioContext', MockAudioContext);

describe('FreeRunOscillator', () => {
  it('starts the underlying osc once at construction', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    expect((osc as any).osc.start).toHaveBeenCalledTimes(1);
  });

  it('setFrequencyAtTime applies coarseTune factor to the scheduled value', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    osc.setCoarseTune(1); // +1 octave
    osc.setFrequencyAtTime(440, 0);
    const setSpy = (osc as any).osc.frequency.setValueAtTime;
    expect(setSpy).toHaveBeenLastCalledWith(880, 0);
  });

  it('triggerAt delegates to setFrequencyAtTime (releaseTime ignored)', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    const spy = vi.spyOn(osc, 'setFrequencyAtTime');
    osc.triggerAt(330, 1.5, 99);
    expect(spy).toHaveBeenCalledWith(330, 1.5);
  });

  it('setPhase is a documented no-op (does not throw)', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    expect(() => osc.setPhase(90)).not.toThrow();
  });

  it('dispose stops + disconnects the osc', () => {
    const ctx = new (AudioContext as any)();
    const osc = new FreeRunOscillator(ctx);
    osc.dispose();
    expect((osc as any).osc.stop).toHaveBeenCalled();
    expect((osc as any).osc.disconnect).toHaveBeenCalled();
  });
});
