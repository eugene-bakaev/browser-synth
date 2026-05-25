import type { IOscillatorModule } from './types';
import { STOP_TAIL_SECONDS } from './constants';

const BUFFER_LENGTH = 2048;

type Bank = Record<OscillatorType, AudioBuffer>;

// Render one cycle of `type` into an AudioBuffer. Sample i = sin(2π·i/N) for
// sine; for sawtooth/square/triangle, we sum the bandlimited Fourier series
// (same coefficients as WaveformTables, but evaluated in the time domain).
function renderOneCycle(ctx: AudioContext, type: OscillatorType): AudioBuffer {
  const buf = ctx.createBuffer(1, BUFFER_LENGTH, ctx.sampleRate);
  const data = buf.getChannelData(0);
  const N = 32; // harmonics

  for (let i = 0; i < BUFFER_LENGTH; i++) {
    const t = i / BUFFER_LENGTH; // 0..1 across one cycle
    const phase = 2 * Math.PI * t;
    let s = 0;
    if (type === 'sine') {
      s = Math.sin(phase);
    } else if (type === 'sawtooth') {
      for (let k = 1; k <= N; k++) {
        const sign = (k % 2 === 1) ? 1 : -1;
        s += sign * (2 / (Math.PI * k)) * Math.sin(k * phase);
      }
    } else if (type === 'square') {
      for (let k = 1; k <= N; k += 2) {
        s += (4 / (Math.PI * k)) * Math.sin(k * phase);
      }
    } else if (type === 'triangle') {
      for (let k = 1; k <= N; k += 2) {
        const sign = (((k - 1) / 2) % 2 === 0) ? 1 : -1;
        s += sign * (8 / (Math.PI * Math.PI * k * k)) * Math.sin(k * phase);
      }
    } else {
      s = Math.sin(phase); // unknown / 'custom' falls back to sine
    }
    data[i] = s;
  }
  return buf;
}

export class WavetableOscillator implements IOscillatorModule {
  private static bank: Bank | null = null;
  private static bankSampleRate: number = 0;

  // Lazy: render once per ctx (sample-rate-keyed; our app never changes it).
  static ensureBank(ctx: AudioContext): Bank {
    if (WavetableOscillator.bank && WavetableOscillator.bankSampleRate === ctx.sampleRate) {
      return WavetableOscillator.bank;
    }
    WavetableOscillator.bank = {
      sine: renderOneCycle(ctx, 'sine'),
      sawtooth: renderOneCycle(ctx, 'sawtooth'),
      square: renderOneCycle(ctx, 'square'),
      triangle: renderOneCycle(ctx, 'triangle'),
      custom: renderOneCycle(ctx, 'sine'),
    };
    WavetableOscillator.bankSampleRate = ctx.sampleRate;
    return WavetableOscillator.bank;
  }

  private ctx: AudioContext;
  private outGain: GainNode;
  private waveform: OscillatorType = 'sawtooth';
  private phaseDeg: number = 0;
  private coarseTune: number = 0;
  private fineCents: number = 0;

  readonly outputs: { main: GainNode };

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    WavetableOscillator.ensureBank(ctx);
    this.outGain = ctx.createGain();
    this.outputs = { main: this.outGain };
  }

  setWaveform(type: OscillatorType) { this.waveform = type; }
  setPhase(deg: number) { this.phaseDeg = ((deg % 360) + 360) % 360; }
  setCoarseTune(oct: number) { this.coarseTune = oct; }
  setFineTune(cents: number) { this.fineCents = cents; }
  setFrequencyAtTime(_freq: number, _time: number) { /* no-op — see RetriggerOscillator note */ }

  triggerAt(freq: number, time: number, releaseTime: number) {
    const bank = WavetableOscillator.ensureBank(this.ctx);
    const buf = bank[this.waveform] ?? bank.sine;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.loopStart = 0;
    src.loopEnd = buf.duration;

    // playbackRate so that one buffer cycle = one cycle of `freq`.
    // Buffer is one cycle long at ctx.sampleRate / BUFFER_LENGTH "natural Hz".
    const naturalHz = this.ctx.sampleRate / BUFFER_LENGTH;
    const rate = (freq * Math.pow(2, this.coarseTune)) / naturalHz;
    src.playbackRate.setValueAtTime(rate, time);
    src.detune.setValueAtTime(this.fineCents, time);

    src.connect(this.outGain);

    const offset = (this.phaseDeg / 360) * buf.duration;
    src.start(time, offset);
    src.stop(releaseTime + STOP_TAIL_SECONDS);
  }

  dispose() {
    this.outGain.disconnect();
  }
}
