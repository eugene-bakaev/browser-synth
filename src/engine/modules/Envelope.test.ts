import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnvelopeModule } from './Envelope';

class AudioParam {
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn();
}

describe('EnvelopeModule', () => {
  let envelope: EnvelopeModule;
  let param: AudioParam;

  beforeEach(() => {
    envelope = new EnvelopeModule();
    param = new AudioParam();
  });

  it('should implement Module interface', () => {
    expect(envelope.name).toBe('Envelope');
    expect(envelope.inputs).toEqual({});
    expect(envelope.outputs).toEqual({});
  });

  it('should trigger ADSR envelope on AudioParam with min and max', () => {
    const time = 10;
    const duration = 1;
    envelope.trigger(param as any, time, duration, 0, 100);

    const attackStart = time + EnvelopeModule.STEAL_RAMP;

    expect(param.cancelAndHoldAtTime).toHaveBeenCalledWith(time);
    // 1ms ramp to min before attack swallows voice-steal clicks
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0, attackStart);
    // Attack and decay shifted by STEAL_RAMP
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(100, attackStart + envelope.a);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(100 * envelope.s, attackStart + envelope.a + envelope.d);

    const releaseTime = time + duration;
    expect(param.cancelAndHoldAtTime).toHaveBeenCalledWith(releaseTime);
    // R now means actual release duration via linearRamp, not a time constant
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0, releaseTime + envelope.r);
  });

  it('should expose STEAL_RAMP as a 1ms anti-click ramp', () => {
    expect(EnvelopeModule.STEAL_RAMP).toBe(0.001);
  });
});
