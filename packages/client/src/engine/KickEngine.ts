import { SoundEngine } from './types';
import { DEFAULT_KICK_PARAMS, type KickEngineParams } from '@fiddle/shared';

// Re-export so existing consumers `import { KickEngineParams } from
// '../engine/KickEngine'` keep working without churn.
export type { KickEngineParams } from '@fiddle/shared';

export class KickEngine implements SoundEngine {
  readonly engineType = 'kick';
  readonly ctx: AudioContext;
  private ampGain: GainNode;
  private activeOscs: Set<OscillatorNode> = new Set();

  // Default param values live in @fiddle/shared (DEFAULT_KICK_PARAMS); kept
  // here as a static for backward-compat with existing consumers.
  static readonly DEFAULT_PARAMS: KickEngineParams = DEFAULT_KICK_PARAMS;

  // Parameters
  private tune: number = DEFAULT_KICK_PARAMS.tune;
  private decay: number = DEFAULT_KICK_PARAMS.decay;
  private click: number = DEFAULT_KICK_PARAMS.click;

  constructor(sharedCtx?: AudioContext, destination?: AudioNode) {
    this.ctx = sharedCtx ?? new AudioContext();
    this.ampGain = this.ctx.createGain();
    this.ampGain.gain.value = 0;
    this.ampGain.connect(destination ?? this.ctx.destination);
  }

  setTune(freq: number) {
    this.tune = Math.max(40, Math.min(120, freq));
  }

  setDecay(val: number) {
    this.decay = Math.max(0.05, Math.min(1.5, val));
  }

  setClick(val: number) {
    this.click = Math.max(0, Math.min(1, val));
  }

  applyParams(params: Record<string, any>) {
    if (params.tune !== undefined) this.setTune(params.tune);
    if (params.decay !== undefined) this.setDecay(params.decay);
    if (params.click !== undefined) this.setClick(params.click);
  }

  trigger(freq: number, duration: number, time?: number, velocity: number = 1.0) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;

    // Create oscillator dynamically at trigger time
    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.connect(this.ampGain);

    // Pitch sweep configuration
    const fClick = 3000 * this.click; // click transient range
    const fStart = this.tune * 4 + fClick;
    const fBody = this.tune * 2;
    const fBase = this.tune;

    // Reset and apply pitch sweep
    osc.frequency.setValueAtTime(fStart, scheduleTime);
    osc.frequency.exponentialRampToValueAtTime(fBody, scheduleTime + 0.008);
    osc.frequency.exponentialRampToValueAtTime(fBase, scheduleTime + 0.048);

    // Track oscillator
    this.activeOscs.add(osc);
    osc.start(scheduleTime);
    osc.stop(scheduleTime + this.decay + 0.1);

    osc.onended = () => {
      try {
        osc.disconnect();
      } catch (e) {}
      this.activeOscs.delete(osc);
    };

    // Reset and apply amplitude envelope (AD)
    this.ampGain.gain.cancelScheduledValues(scheduleTime);
    this.ampGain.gain.setValueAtTime(0, scheduleTime);
    this.ampGain.gain.linearRampToValueAtTime(velocity, scheduleTime + 0.002);
    // Exponential decay to a near-zero value (0.001), then drop to 0
    this.ampGain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 0.002 + this.decay);
    this.ampGain.gain.setValueAtTime(0, scheduleTime + 0.002 + this.decay + 0.01);
  }

  dispose() {
    this.activeOscs.forEach((osc) => {
      try {
        osc.stop();
      } catch (e) {}
      try {
        osc.disconnect();
      } catch (e) {}
    });
    this.activeOscs.clear();
    this.ampGain.disconnect();
  }
}

