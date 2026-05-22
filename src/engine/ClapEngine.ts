import { SoundEngine } from './types';
import { getNoiseBuffer } from './modules/Noise';

export class ClapEngine implements SoundEngine {
  readonly engineType = 'clap';
  readonly ctx: AudioContext;

  // Noise components
  private noiseGain: GainNode;
  private noiseFilter: BiquadFilterNode;
  private ampGain: GainNode;

  // Parameters
  private decay: number = 0.25;    // Clap tail decay in seconds (0.05 - 0.8)
  private tone: number = 1000;     // Bandpass filter cutoff frequency (500 - 3000)
  private sloppy: number = 0.015;  // Spacing between initial impulses (0.005 - 0.03)

  constructor(sharedCtx?: AudioContext, destination?: AudioNode) {
    this.ctx = sharedCtx ?? new AudioContext();

    // 1. Initialize filter
    this.noiseFilter = this.ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = this.tone;
    this.noiseFilter.Q.value = 1.2;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 1.0;

    // Master VCA
    this.ampGain = this.ctx.createGain();
    this.ampGain.gain.value = 0;

    this.noiseFilter.connect(this.noiseGain);
    this.noiseGain.connect(this.ampGain);
    this.ampGain.connect(destination ?? this.ctx.destination);
  }

  setDecay(val: number) {
    this.decay = Math.max(0.05, Math.min(0.8, val));
  }

  setTone(val: number) {
    this.tone = Math.max(500, Math.min(3000, val));
    this.noiseFilter.frequency.setValueAtTime(this.tone, this.ctx.currentTime);
  }

  setSloppy(val: number) {
    this.sloppy = Math.max(0.005, Math.min(0.03, val));
  }

  applyParams(params: Record<string, any>) {
    if (params.decay !== undefined) this.setDecay(params.decay);
    if (params.tone !== undefined) this.setTone(params.tone);
    if (params.sloppy !== undefined) this.setSloppy(params.sloppy);
  }

  trigger(freq: number, duration: number, time?: number) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;
    const s = this.sloppy;
    const d = this.decay;

    // 1. Create and start a noise buffer source for the duration of the clap
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = getNoiseBuffer(this.ctx);
    noiseSource.loop = true;
    noiseSource.connect(this.noiseFilter);
    
    const totalDuration = s * 3 + d;
    noiseSource.start(scheduleTime);
    noiseSource.stop(scheduleTime + totalDuration + 0.1);

    noiseSource.onended = () => {
      try {
        noiseSource.disconnect();
      } catch (e) {}
    };

    // 2. Schedule multi-trigger envelope for the clap
    this.ampGain.gain.cancelScheduledValues(scheduleTime);
    this.ampGain.gain.setValueAtTime(0, scheduleTime);

    // Pulse 1
    this.ampGain.gain.linearRampToValueAtTime(0.8, scheduleTime + 0.001);
    this.ampGain.gain.exponentialRampToValueAtTime(0.01, scheduleTime + 0.008);

    // Pulse 2
    this.ampGain.gain.setValueAtTime(0.01, scheduleTime + s);
    this.ampGain.gain.linearRampToValueAtTime(0.8, scheduleTime + s + 0.001);
    this.ampGain.gain.exponentialRampToValueAtTime(0.01, scheduleTime + s + 0.008);

    // Pulse 3
    this.ampGain.gain.setValueAtTime(0.01, scheduleTime + 2 * s);
    this.ampGain.gain.linearRampToValueAtTime(0.8, scheduleTime + 2 * s + 0.001);
    this.ampGain.gain.exponentialRampToValueAtTime(0.01, scheduleTime + 2 * s + 0.008);

    // Main Tail
    this.ampGain.gain.setValueAtTime(0.01, scheduleTime + 3 * s);
    this.ampGain.gain.linearRampToValueAtTime(0.8, scheduleTime + 3 * s + 0.001);
    this.ampGain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 3 * s + 0.001 + d);
    this.ampGain.gain.setValueAtTime(0, scheduleTime + 3 * s + 0.001 + d + 0.01);
  }

  dispose() {
    this.noiseFilter.disconnect();
    this.noiseGain.disconnect();
    this.ampGain.disconnect();
  }
}
