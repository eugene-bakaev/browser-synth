// PulseProcessor — AudioWorklet pulse oscillator with adjustable duty cycle.
//
// Runs in the audio rendering thread (AudioWorkletGlobalScope). One processor
// instance per AudioWorkletNode; SynthVoice creates two (one per osc).
//
// DSP: naive bipolar pulse (+1 while phase < pulseWidth, -1 otherwise) with
// two PolyBLEP corrections per cycle — one at the rising edge (phase=0), one
// at the falling edge (phase=pulseWidth). PolyBLEP gives proper per-pitch
// anti-aliasing without needing pre-computed wave tables.
//
// AudioParam wiring: frequency + detune are a-rate so a knob turn or envelope
// can sweep pitch sample-accurately. pulseWidth is k-rate; the duty cycle is
// a static knob, not an LFO target (LFO modulation is deferred work).
//
// NOTE: polyBLEP is also exported from ./polyblep.ts for Node-side unit
// tests. Keep both implementations in sync if you change either.
class PulseProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'frequency',  defaultValue: 440, minValue: 0,    maxValue: 20000, automationRate: 'a-rate' },
      { name: 'detune',     defaultValue: 0,   minValue: -1200, maxValue: 1200, automationRate: 'a-rate' },
      { name: 'pulseWidth', defaultValue: 0.5, minValue: 0.01, maxValue: 0.99,  automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.phase = 0;
  }

  process(_inputs, outputs, params) {
    const out = outputs[0][0];
    if (!out) return true;

    const freq = params.frequency;
    const detune = params.detune;
    const pw = params.pulseWidth[0];
    const aRateFreq = freq.length > 1;
    const aRateDetune = detune.length > 1;
    const sr = sampleRate;

    let phase = this.phase;

    for (let i = 0; i < out.length; i++) {
      const f0 = aRateFreq ? freq[i] : freq[0];
      const d = aRateDetune ? detune[i] : detune[0];
      const f = f0 * Math.pow(2, d / 1200);
      const dt = f / sr;

      let v = (phase < pw) ? 1 : -1;
      v += polyBLEP(phase, dt);
      // Falling edge at phase == pw; shift so the BLEP-correction window
      // straddles that location and sign-flip (it's a -1 step).
      let tFall = phase - pw;
      if (tFall < 0) tFall += 1;
      v -= polyBLEP(tFall, dt);

      out[i] = v;

      phase += dt;
      if (phase >= 1) phase -= 1;
    }

    this.phase = phase;
    return true;
  }
}

// Inlined copy of ./polyblep.ts. Worklet modules don't reliably support
// imports across all bundler+browser combos; duplication is the safer choice
// for ~8 lines of math. If you change one, change the other.
function polyBLEP(t, dt) {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

registerProcessor('pulse', PulseProcessor);
