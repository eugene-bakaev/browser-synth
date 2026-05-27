import { Module } from '../types';

export class EnvelopeModule implements Module {
  readonly name = 'Envelope';
  readonly inputs = {};
  readonly outputs = {};

  a = 0.01; d = 0.2; s = 0.5; r = 0.5;

  // 1ms ramp from whatever value the param holds at trigger time down to `min`,
  // preventing audible clicks when a stolen voice was mid-release.
  static readonly STEAL_RAMP = 0.001;

  trigger(param: AudioParam, time: number, duration: number, min = 0, max = 1) {
    const range = max - min;

    if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(time);
    } else {
        param.cancelScheduledValues(time);
    }

    // Smooth handoff: ramp from the held value to `min` over 1ms. Shifts the
    // attack window by 1ms (inaudible) but eliminates the click that
    // setValueAtTime(min, time) would produce when stealing a voice mid-release.
    const attackStart = time + EnvelopeModule.STEAL_RAMP;
    param.linearRampToValueAtTime(min, attackStart);

    param.linearRampToValueAtTime(min + range, attackStart + this.a);
    param.linearRampToValueAtTime(min + range * this.s, attackStart + this.a + this.d);

    const releaseTime = time + duration;
    if (typeof param.cancelAndHoldAtTime === 'function') {
        param.cancelAndHoldAtTime(releaseTime);
    } else {
        param.cancelScheduledValues(releaseTime);
    }
    // Linear ramp to `min` over exactly `this.r` seconds — R now means
    // "release duration," not a time constant.
    param.linearRampToValueAtTime(min, releaseTime + Math.max(this.r, 0.001));
  }
}
