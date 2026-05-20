import { Module, ModulePort } from '../types';

export class EnvelopeModule {
  a = 0.01; d = 0.2; s = 0.5; r = 0.5;

  trigger(param: AudioParam, time: number, duration: number) {
    param.cancelScheduledValues(time);
    param.setValueAtTime(0, time);
    param.linearRampToValueAtTime(1, time + this.a);
    param.linearRampToValueAtTime(this.s, time + this.a + this.d);
    
    const releaseTime = time + duration;
    param.cancelScheduledValues(releaseTime);
    param.setValueAtTime(this.s, releaseTime);
    param.linearRampToValueAtTime(0, releaseTime + this.r);
  }
}
