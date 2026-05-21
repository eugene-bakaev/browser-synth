import { SoundEngine } from './types';
import { getNoiseBuffer } from './modules/Noise';

export class HatEngine implements SoundEngine {
  readonly engineType = 'hat';
  readonly ctx: AudioContext;
  
  // Metallic components
  private oscs: OscillatorNode[] = [];
  private metalMixer: GainNode;
  private metalFilter: BiquadFilterNode;
  private metalGain: GainNode;

  // Noise components
  private noiseGain: GainNode;

  // Output stage
  private bandpassFilter: BiquadFilterNode;
  private ampGain: GainNode;

  // Parameters
  private decay: number = 0.15;    // Decay time in seconds (0.02 - 0.6)
  private tone: number = 8000;     // Bandpass filter cutoff frequency (3000 - 14000)
  private metallic: number = 0.5;  // Blend between noise (0) and metal (1)

  constructor(sharedCtx?: AudioContext) {
    this.ctx = sharedCtx ?? new AudioContext();

    // 1. Initialize Metallic Source (TR-808 style: 6 detuned square waves)
    this.metalMixer = this.ctx.createGain();
    this.metalMixer.gain.value = 0.15; // keep it balanced

    const metalFreqs = [205.3, 369.6, 304.4, 522.7, 370.0, 800.0];
    metalFreqs.forEach((freq) => {
      const osc = this.ctx.createOscillator();
      osc.type = 'square';
      osc.frequency.value = freq;
      osc.connect(this.metalMixer);
      osc.start();
      this.oscs.push(osc);
    });

    // Highpass filter for the metallic oscillators to keep only the high-frequency sizzle
    this.metalFilter = this.ctx.createBiquadFilter();
    this.metalFilter.type = 'highpass';
    this.metalFilter.frequency.value = 1000; // block low frequencies
    this.metalMixer.connect(this.metalFilter);

    this.metalGain = this.ctx.createGain();
    this.metalFilter.connect(this.metalGain);

    // 2. Initialize Noise Source Gain
    this.noiseGain = this.ctx.createGain();

    // 3. Initialize Bandpass Filter & Master VCA
    this.bandpassFilter = this.ctx.createBiquadFilter();
    this.bandpassFilter.type = 'bandpass';
    this.bandpassFilter.frequency.value = this.tone;
    this.bandpassFilter.Q.value = 1.5; // moderately narrow bandpass

    // Connect sources to the bandpass filter
    this.metalGain.connect(this.bandpassFilter);
    this.noiseGain.connect(this.bandpassFilter);

    // Master VCA
    this.ampGain = this.ctx.createGain();
    this.ampGain.gain.value = 0;

    this.bandpassFilter.connect(this.ampGain);
    this.ampGain.connect(this.ctx.destination);

    // Sync parameters
    this.setMetallic(this.metallic);
  }

  setDecay(val: number) {
    this.decay = val;
  }

  setTone(val: number) {
    this.tone = val;
    this.bandpassFilter.frequency.setValueAtTime(val, this.ctx.currentTime);
  }

  setMetallic(val: number) {
    this.metallic = val;
    const time = this.ctx.currentTime;
    this.noiseGain.gain.setValueAtTime(1.0 - val, time);
    this.metalGain.gain.setValueAtTime(val, time);
  }

  applyParams(params: Record<string, any>) {
    if (params.decay !== undefined) this.setDecay(params.decay);
    if (params.tone !== undefined) this.setTone(params.tone);
    if (params.metallic !== undefined) this.setMetallic(params.metallic);
  }

  trigger(freq: number, duration: number, time?: number) {
    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }
    const scheduleTime = time ?? this.ctx.currentTime;

    // 1. Create a one-shot noise source
    const noiseSource = this.ctx.createBufferSource();
    noiseSource.buffer = getNoiseBuffer(this.ctx);
    noiseSource.loop = true;
    noiseSource.connect(this.noiseGain);
    
    // Play the noise source slightly longer than decay to prevent abrupt cuts before VCA closes
    noiseSource.start(scheduleTime);
    noiseSource.stop(scheduleTime + this.decay + 0.1);

    // Safeguard disconnection
    noiseSource.onended = () => {
      try {
        noiseSource.disconnect();
      } catch (e) {
        // already disconnected
      }
    };

    // 2. Trigger the Amplitude Envelope
    this.ampGain.gain.cancelScheduledValues(scheduleTime);
    this.ampGain.gain.setValueAtTime(0, scheduleTime);
    // Instant attack for hat click
    this.ampGain.gain.linearRampToValueAtTime(0.8, scheduleTime + 0.002);
    // Exponential decay to silence
    this.ampGain.gain.exponentialRampToValueAtTime(0.001, scheduleTime + 0.002 + this.decay);
    this.ampGain.gain.setValueAtTime(0, scheduleTime + 0.002 + this.decay + 0.01);
  }

  dispose() {
    this.oscs.forEach((osc) => {
      try {
        osc.stop();
      } catch (e) {}
      osc.disconnect();
    });
    this.metalMixer.disconnect();
    this.metalFilter.disconnect();
    this.metalGain.disconnect();
    this.noiseGain.disconnect();
    this.bandpassFilter.disconnect();
    this.ampGain.disconnect();
  }
}
