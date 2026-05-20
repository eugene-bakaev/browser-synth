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

    expect(param.cancelAndHoldAtTime).toHaveBeenCalledWith(time);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(100, time + envelope.a);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(100 * envelope.s, time + envelope.a + envelope.d);
    
    const releaseTime = time + duration;
    expect(param.cancelAndHoldAtTime).toHaveBeenCalledWith(releaseTime);
    expect(param.setTargetAtTime).toHaveBeenCalledWith(0, releaseTime, expect.any(Number));
  });
});
