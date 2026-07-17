//
// Portamento (spec 2026-07-16): constant-time glide in log2-pitch space.
// Pure per-voice state — no ParamSlot, no allocation; the Voice feeds it the
// per-sample glide.time slot value. noteOn latches the interval from the
// PREVIOUS NOTE'S TARGET pitch (not the mid-glide instantaneous pitch), so
// fast retriggers stay deterministic. Both endpoints are Nyquist-capped by
// the callers, and the rendered freq is always between them, so no clamp here.

export class Glide {
  private remainOct = 0;   // current offset from the target pitch (octaves), decays to 0
  private intervalOct = 0; // |offset at noteOn| — fixes the constant-time rate
  private lastFreq = 0;    // previous note's target freq; 0 = never played

  constructor(private readonly sampleRate: number) {}

  /** Latch glide state for a new note. Glides only for mono notes with a
   *  previous pitch to glide from; poly notes and the first-ever note snap.
   *  lastFreq updates unconditionally so a mono note after a poly note
   *  glides from whatever this voice played last. */
  noteOn(targetFreq: number, mono: boolean): void {
    if (mono && this.lastFreq > 0) {
      this.remainOct = Math.log2(this.lastFreq / targetFreq);
      this.intervalOct = Math.abs(this.remainOct);
    } else {
      this.remainOct = 0;
      this.intervalOct = 0;
    }
    this.lastFreq = targetFreq;
  }

  /** Per-sample frequency for target `freq`, advancing the glide by one
   *  sample of `glideSeconds` (the smoothed/modulated glide.time slot value,
   *  already clamped ≥ 0.001 by ParamSlot). Constant-time: the latched
   *  interval crosses in glideSeconds; re-reading the time per sample lets
   *  matrix mod bend the rate mid-glide without ever overshooting. */
  next(freq: number, glideSeconds: number): number {
    if (this.remainOct === 0) return freq;
    const step = this.intervalOct / (glideSeconds * this.sampleRate);
    const r = this.remainOct;
    this.remainOct = r > step ? r - step : r < -step ? r + step : 0;
    return this.remainOct === 0 ? freq : freq * Math.pow(2, this.remainOct);
  }
}
