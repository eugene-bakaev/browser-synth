import { SoundEngine } from './types';

export class KickEngine implements SoundEngine {
  readonly engineType = 'kick';
  readonly ctx: AudioContext;
  private osc: OscillatorNode;
  private ampGain: GainNode;

  // Parameters
  private tune: number = 55;   // Base pitch in Hz (40 - 120)
  private decay: number = 0.3; // Decay time in seconds (0.05 - 1.5)
  private click: number = 0.5; // Click depth (0.0 - 1.0)

  constructor(sharedCtx?: AudioContext) {
    this.ctx = sharedCtx ?? new AudioContext();
    this.osc = this.ctx.createOscillator();
    this.ampGain = this.ctx.createGain();

    this.osc.type = 'sine';
    this.ampGain.gain.value = 0;

    this.osc.connect(this.ampGain);
    this.ampGain.connect(this.ctx.destination);
    
    this.osc.start();
  }

  setTune(freq: number) {
    this.tune = freq;
  }

  setDecay(val: number) {
    this.decay = val;
  }

  setClick(val: number) {
    this.click = val;
  }

  applyParams(params: Record<string, any>) {
    if (params.tune !== undefined) this.setTune(params.tune);
    if (params.decay !== undefined) this.setDecay(params.decay);
    if (params.click !== undefined) this.setClick(params.click);
  }

  trigger(freq: number, duration: number, time?: number) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;

    // Pitch sweep configuration
    const fClick = 3000 * this.click; // click transient range
    const fStart = this.tune * 4 + fClick;
    const fBody = this.tune * 2;
    const fBase = this.tune;

    // Reset and apply pitch sweep
    this.osc.frequency.cancelScheduledValues(scheduleTime);
    this.osc.frequency.setValueAtTime(fStart, scheduleTime);
    this.osc.frequency.exponentialRampToValueAtTime(fBody, scheduleTime + 0.008);
    this.osc.frequency.exponentialRampToValueAtTime(fBase, scheduleTime + 0.048);

    // Reset and apply amplitude envelope (AD)
    this.ampGain.gain.cancelScheduledValues(scheduleTime);
    this.ampGain.gain.setValueAtTime(0, scheduleTime);
    this.ampGain.gain.linearRampToValueAtTime(1.0, scheduleTime + 0.002);
    // Exponential decay to a near-zero value (0.001), then drop to 0
    this.ampGain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 0.002 + this.decay);
    this.ampGain.gain.setValueAtTime(0, scheduleTime + 0.002 + this.decay + 0.01);
  }

  dispose() {
    try {
      this.osc.stop();
    } catch (e) {
      // already stopped or not started
    }
    this.osc.disconnect();
    this.ampGain.disconnect();
  }
}
