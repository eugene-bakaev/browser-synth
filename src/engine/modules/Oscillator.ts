import { Module, ModulePort } from '../types';

// Hybrid oscillator: native OscillatorNode for sine/sawtooth/triangle (which
// the platform already band-limits cleanly), AudioWorkletNode for square
// (our PolyBLEP processor — see ../worklets/pulse-processor.js). The native
// 'square' is fixed at 50% duty cycle; routing through a worklet lets us
// expose pulse width as a continuous knob without sacrificing audio quality.
//
// Both source nodes live for the module's lifetime; setWaveform connects the
// appropriate one to the output GainNode and disconnects the other. The gain
// node is the stable output port — downstream wiring never has to be redone
// when waveforms change. Frequency and detune writes fan out to BOTH sources
// so a mid-note waveform swap preserves pitch.
//
// Caller MUST ensure ctx.audioWorklet.addModule(pulseWorkletUrl) has resolved
// before constructing this — see useSynth.buildAudioState. Construction of
// an AudioWorkletNode for an unregistered processor name throws synchronously.
export class OscillatorModule implements Module {
  readonly name = 'Oscillator';
  private ctx: AudioContext;
  private nativeOsc: OscillatorNode;
  private pulseNode: AudioWorkletNode;
  private gain: GainNode;
  private active: 'native' | 'pulse' = 'native';

  private waveform: OscillatorType = 'sawtooth';
  private baseFreq: number = 440;
  coarseTune: number = 0; // -3 to +3 octaves
  private fineCents: number = 0;
  private pulseWidth: number = 0.5;

  readonly inputs = {};
  readonly outputs: Record<string, ModulePort>;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.gain = ctx.createGain();

    this.nativeOsc = ctx.createOscillator();
    this.nativeOsc.type = this.waveform;
    this.nativeOsc.start();

    this.pulseNode = new AudioWorkletNode(ctx, 'pulse');

    // Active source connects to gain. The other is built but unconnected
    // (still running; just nothing downstream listens to it).
    this.nativeOsc.connect(this.gain);

    this.outputs = { main: this.gain };
  }

  setFrequencyAtTime(freq: number, time: number) {
    this.baseFreq = freq;
    const finalFreq = this.baseFreq * Math.pow(2, this.coarseTune);
    // Fan out so a mid-note waveform swap (square ↔ saw, etc.) doesn't drop
    // pitch on the newly-activated source.
    this.nativeOsc.frequency.setValueAtTime(finalFreq, time);
    const pulseFreq = this.pulseNode.parameters.get('frequency');
    if (pulseFreq) pulseFreq.setValueAtTime(finalFreq, time);
  }

  setFrequency(freq: number) {
    this.setFrequencyAtTime(freq, this.ctx.currentTime);
  }

  setCoarseTune(octaves: number) {
    this.coarseTune = octaves;
    this.setFrequency(this.baseFreq);
  }

  setFineTune(cents: number) {
    this.fineCents = cents;
    this.nativeOsc.detune.setValueAtTime(cents, this.ctx.currentTime);
    const pulseDetune = this.pulseNode.parameters.get('detune');
    if (pulseDetune) pulseDetune.setValueAtTime(cents, this.ctx.currentTime);
  }

  setWaveform(type: OscillatorType) {
    this.waveform = type;
    if (type === 'square') {
      if (this.active !== 'pulse') {
        this.nativeOsc.disconnect();
        this.pulseNode.connect(this.gain);
        this.active = 'pulse';
      }
    } else {
      this.nativeOsc.type = type;
      if (this.active !== 'native') {
        this.pulseNode.disconnect();
        this.nativeOsc.connect(this.gain);
        this.active = 'native';
      }
    }
  }

  setPulseWidth(width: number) {
    this.pulseWidth = Math.max(0.05, Math.min(0.95, width));
    const pw = this.pulseNode.parameters.get('pulseWidth');
    if (pw) pw.setValueAtTime(this.pulseWidth, this.ctx.currentTime);
  }

  dispose() {
    try {
      this.nativeOsc.stop();
    } catch (e) {
      // already stopped or not started
    }
    this.nativeOsc.disconnect();
    try {
      this.pulseNode.disconnect();
    } catch (e) {
      // already disconnected
    }
    this.gain.disconnect();
  }
}
