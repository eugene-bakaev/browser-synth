import { Module } from '../types';

export class EnvelopeModule implements Module {
  readonly name = 'Envelope';
  readonly inputs = {};
  readonly outputs = {};

  a = 0.01; d = 0.2; s = 0.5; r = 0.5;

  trigger(param: AudioParam, time: number, duration: number, min = 0, max = 1) {
    const range = max - min;
    
    if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(time);
    } else {
        param.cancelScheduledValues(time);
    }
    
    // Anchor the starting value of the envelope at trigger time to prevent pitch/cutoff slides from previous states
    param.setValueAtTime(min, time);
    
    param.linearRampToValueAtTime(min + range, time + this.a);
    param.linearRampToValueAtTime(min + range * this.s, time + this.a + this.d);
    
    const releaseTime = time + duration;
    if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(releaseTime);
    } else {
        param.cancelScheduledValues(releaseTime);
    }
    // Smooth ramp down from current value using setTargetAtTime
    // Time constant = release / 3 gets us ~95% of the way there in `release` seconds
    param.setTargetAtTime(min, releaseTime, Math.max(this.r / 3, 0.005));
  }
}
