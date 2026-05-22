import { SoundEngine } from './types';
import { getNoiseBuffer } from './modules/Noise';

export class SnareEngine implements SoundEngine {
  readonly engineType = 'snare';
  readonly ctx: AudioContext;

  // Body (Tonal) components
  private bodyGain: GainNode;
  private activeOscs: Set<OscillatorNode> = new Set();

  // Snare Wires (Noise) components
  private noiseGain: GainNode;
  private noiseFilter: BiquadFilterNode;
  private activeSources: Set<AudioBufferSourceNode> = new Set();

  // Master output
  private masterGain: GainNode;

  // Parameters
  private tune: number = 180;      // Base pitch in Hz (100 - 250)
  private decay: number = 0.25;    // Snare wires decay in seconds (0.05 - 0.8)
  private snappy: number = 0.5;    // Noise level ratio vs body (0.0 - 1.0)

  constructor(sharedCtx?: AudioContext, destination?: AudioNode) {
    this.ctx = sharedCtx ?? new AudioContext();

    // 1. Initialize Body (Tonal) gain
    this.bodyGain = this.ctx.createGain();
    this.bodyGain.gain.value = 0;

    // 2. Initialize Snare Wires (Noise) component
    this.noiseFilter = this.ctx.createBiquadFilter();
    this.noiseFilter.type = 'bandpass';
    this.noiseFilter.frequency.value = 1800; // centered in mid-high snare region
    this.noiseFilter.Q.value = 1.0;

    this.noiseGain = this.ctx.createGain();
    this.noiseGain.gain.value = 0;

    this.noiseFilter.connect(this.noiseGain);

    // 3. Output Stage
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.8; // general headroom level

    this.bodyGain.connect(this.masterGain);
    this.noiseGain.connect(this.masterGain);
    this.masterGain.connect(destination ?? this.ctx.destination);
  }

  setTune(freq: number) {
    this.tune = Math.max(100, Math.min(250, freq));
  }

  setDecay(val: number) {
    this.decay = Math.max(0.05, Math.min(0.8, val));
  }

  setSnappy(val: number) {
    this.snappy = Math.max(0, Math.min(1, val));
  }

  applyParams(params: Record<string, any>) {
    if (params.tune !== undefined) this.setTune(params.tune);
    if (params.decay !== undefined) this.setDecay(params.decay);
    if (params.snappy !== undefined) this.setSnappy(params.snappy);
  }

  trigger(freq: number, duration: number, time?: number, velocity: number = 1.0) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;

    // --- 1. Trigger Body (Tonal) ---
    // Instantiate triangle oscillator dynamically
    const bodyOsc = this.ctx.createOscillator();
    bodyOsc.type = 'triangle';
    bodyOsc.connect(this.bodyGain);

    // Fast pitch sweep (e.g. from tune * 2 down to tune)
    bodyOsc.frequency.setValueAtTime(this.tune * 1.8, scheduleTime);
    bodyOsc.frequency.exponentialRampToValueAtTime(this.tune, scheduleTime + 0.06);

    this.activeOscs.add(bodyOsc);
    bodyOsc.start(scheduleTime);
    bodyOsc.stop(scheduleTime + 0.15); // body decay is tight, 0.08s, so 0.15s is plenty

    bodyOsc.onended = () => {
      try {
        bodyOsc.disconnect();
      } catch (e) {}
      this.activeOscs.delete(bodyOsc);
    };

    // Amplitude envelope for the body (always a tight decay, e.g. 0.08s)
    const bodyMaxGain = (1.0 - this.snappy) * 1.2 * velocity;
    this.bodyGain.gain.cancelScheduledValues(scheduleTime);
    this.bodyGain.gain.setValueAtTime(0, scheduleTime);
    this.bodyGain.gain.linearRampToValueAtTime(bodyMaxGain, scheduleTime + 0.002);
    this.bodyGain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 0.002 + 0.08);
    this.bodyGain.gain.setValueAtTime(0, scheduleTime + 0.002 + 0.08 + 0.01);

    // --- 2. Trigger Snare Wires (Noise) ---
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = getNoiseBuffer(this.ctx);
    noiseSource.loop = true;
    noiseSource.connect(this.noiseFilter);
    this.activeSources.add(noiseSource);
    noiseSource.start(scheduleTime);
    noiseSource.stop(scheduleTime + this.decay + 0.1);

    noiseSource.onended = () => {
      try {
        noiseSource.disconnect();
      } catch (e) {}
      this.activeSources.delete(noiseSource);
    };

    // Amplitude envelope for noise (decay controlled by user)
    const noiseMaxGain = this.snappy * 1.5 * velocity;
    this.noiseGain.gain.cancelScheduledValues(scheduleTime);
    this.noiseGain.gain.setValueAtTime(0, scheduleTime);
    this.noiseGain.gain.linearRampToValueAtTime(noiseMaxGain, scheduleTime + 0.002);
    this.noiseGain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 0.002 + this.decay);
    this.noiseGain.gain.setValueAtTime(0, scheduleTime + 0.002 + this.decay + 0.01);
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

    this.activeSources.forEach((src) => {
      try {
        src.stop();
      } catch (e) {}
      try {
        src.disconnect();
      } catch (e) {}
    });
    this.activeSources.clear();

    this.bodyGain.disconnect();
    this.noiseFilter.disconnect();
    this.noiseGain.disconnect();
    this.masterGain.disconnect();
  }
}
