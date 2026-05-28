import { SoundEngine } from './types';
import { getNoiseBuffer } from './modules/Noise';
import { DEFAULT_HAT_PARAMS, type HatEngineParams } from '@fiddle/shared';

// Re-export so existing consumers `import { HatEngineParams } from
// '../engine/HatEngine'` keep working without churn.
export type { HatEngineParams } from '@fiddle/shared';

export class HatEngine implements SoundEngine {
  readonly engineType = 'hat';
  readonly ctx: AudioContext;

  // Metallic components
  private activeOscs: Set<OscillatorNode> = new Set();
  private activeSources: Set<AudioBufferSourceNode> = new Set();
  private metalMixer: GainNode;
  private metalFilter: BiquadFilterNode;
  private metalGain: GainNode;

  // Noise components
  private noiseGain: GainNode;

  // Output stage
  private bandpassFilter: BiquadFilterNode;
  private ampGain: GainNode;

  // Default param values live in @fiddle/shared (DEFAULT_HAT_PARAMS); kept
  // here as a static for backward-compat with existing consumers.
  static readonly DEFAULT_PARAMS: HatEngineParams = DEFAULT_HAT_PARAMS;

  // Parameters
  private decay: number = DEFAULT_HAT_PARAMS.decay;
  private tone: number = DEFAULT_HAT_PARAMS.tone;
  private metallic: number = DEFAULT_HAT_PARAMS.metallic;

  constructor(sharedCtx?: AudioContext, destination?: AudioNode) {
    this.ctx = sharedCtx ?? new AudioContext();

    // 1. Initialize Metallic Mixer
    this.metalMixer = this.ctx.createGain();
    this.metalMixer.gain.value = 0.15; // keep it balanced

    // Highpass filter for the metallic oscillators to keep only the high-frequency sizzle
    this.metalFilter = this.ctx.createBiquadFilter();
    this.metalFilter.type = 'highpass';
    this.metalFilter.frequency.value = 7000;

    this.metalFilter.connect(this.metalMixer);

    // 2. Bandpass filter for the entire hat sound (shared shaping)
    this.bandpassFilter = this.ctx.createBiquadFilter();
    this.bandpassFilter.type = 'bandpass';
    this.bandpassFilter.frequency.value = this.tone;
    this.bandpassFilter.Q.value = 1.2;

    // 3. Mixing stages
    this.metalGain = this.ctx.createGain();
    this.noiseGain = this.ctx.createGain();

    // Connect sources to the bandpass filter
    this.metalGain.connect(this.bandpassFilter);
    this.noiseGain.connect(this.bandpassFilter);

    // Master VCA
    this.ampGain = this.ctx.createGain();
    this.ampGain.gain.value = 0;

    this.bandpassFilter.connect(this.ampGain);
    this.ampGain.connect(destination ?? this.ctx.destination);

    // Sync parameters
    this.setMetallic(this.metallic);
  }

  setDecay(val: number) {
    this.decay = Math.max(0.02, Math.min(0.6, val));
  }

  setTone(val: number) {
    this.tone = Math.max(3000, Math.min(14000, val));
    this.bandpassFilter.frequency.setTargetAtTime(this.tone, this.ctx.currentTime, 0.01);
  }

  setMetallic(val: number) {
    this.metallic = Math.max(0, Math.min(1, val));
    const time = this.ctx.currentTime;
    this.noiseGain.gain.setTargetAtTime(1.0 - this.metallic, time, 0.01);
    this.metalGain.gain.setTargetAtTime(this.metallic, time, 0.01);
  }

  applyParams(params: Record<string, any>) {
    if (params.decay !== undefined) this.setDecay(params.decay);
    if (params.tone !== undefined) this.setTone(params.tone);
    if (params.metallic !== undefined) this.setMetallic(params.metallic);
  }

  trigger(freq: number, duration: number, time?: number, velocity: number = 1.0) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;

    // 1. Instantiate the metallic component square-wave oscillators dynamically
    const metalFreqs = [205.3, 369.6, 304.4, 522.7, 370.0, 800.0];
    metalFreqs.forEach((f) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = f;
      osc.connect(this.metalMixer);
      
      this.activeOscs.add(osc);
      osc.start(scheduleTime);
      osc.stop(scheduleTime + this.decay + 0.1);
      
      osc.onended = () => {
        try {
          osc.disconnect();
        } catch (e) {}
        this.activeOscs.delete(osc);
      };
    });

    // 2. Create a one-shot noise source
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = getNoiseBuffer(this.ctx);
    noiseSource.loop = true;
    noiseSource.connect(this.noiseGain);
    
    // Play the noise source slightly longer than decay to prevent abrupt cuts before VCA closes
    this.activeSources.add(noiseSource);
    noiseSource.start(scheduleTime);
    noiseSource.stop(scheduleTime + this.decay + 0.1);

    // Safeguard disconnection
    noiseSource.onended = () => {
      try {
        noiseSource.disconnect();
      } catch (e) {
        // already disconnected
      }
      this.activeSources.delete(noiseSource);
    };

    // 3. Trigger the Amplitude Envelope
    this.ampGain.gain.cancelScheduledValues(scheduleTime);
    this.ampGain.gain.setValueAtTime(0, scheduleTime);
    // Instant attack for hat click
    this.ampGain.gain.linearRampToValueAtTime(0.8 * velocity, scheduleTime + 0.002);
    // Exponential decay to silence
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

    this.activeSources.forEach((src) => {
      try {
        src.stop();
      } catch (e) {}
      try {
        src.disconnect();
      } catch (e) {}
    });
    this.activeSources.clear();
    
    this.metalMixer.disconnect();
    this.metalFilter.disconnect();
    this.metalGain.disconnect();
    this.noiseGain.disconnect();
    this.bandpassFilter.disconnect();
    this.ampGain.disconnect();
  }
}

