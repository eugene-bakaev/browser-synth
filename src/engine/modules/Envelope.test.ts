import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EnvelopeModule } from './Envelope';

class AudioParam {
  cancelScheduledValues = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
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

  it('should trigger ADSR envelope on AudioParam', () => {
    const time = 10;
    const duration = 1;
    envelope.trigger(param as any, time, duration);

    expect(param.cancelScheduledValues).toHaveBeenCalledWith(time);
    expect(param.setValueAtTime).toHaveBeenCalledWith(0, time);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(1, time + envelope.a);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(envelope.s, time + envelope.a + envelope.d);
    
    const releaseTime = time + duration;
    expect(param.cancelScheduledValues).toHaveBeenCalledWith(releaseTime);
    expect(param.setValueAtTime).toHaveBeenCalledWith(envelope.s, releaseTime);
    expect(param.linearRampToValueAtTime).toHaveBeenCalledWith(0, releaseTime + envelope.r);
  });
});
