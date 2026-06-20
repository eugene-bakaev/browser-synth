// Per-voice colored-noise source (spec 2026-06-20). A white xorshift32 draw is
// morphed across five textbook noise colors by spectral slope; `color` 0..1 picks
// the position with white at center:
//   0.0 brown(-6 dB/oct) · 0.25 pink(-3) · 0.5 white(0) · 0.75 blue(+3) · 1.0 violet(+6)
// Every anchor derives from the one white draw plus a Paul Kellet pink filter:
// integration lowers the slope 6 dB/oct (brown), differentiation raises it 6 dB/oct
// (blue, violet). Per-anchor gains match each color's RMS to white so the knob is
// purely tonal. Pure, allocation-free, deterministic from the seed (kernel ABI §6.7).

// White-RMS / raw-anchor-RMS, measured over a long white run. Locked by the
// 'all anchors are loudness-matched to white' test in Noise.test.ts.
const PINK_GAIN = 0.32821;
const BROWN_GAIN = 10.05331;
const BLUE_GAIN = 1.68021;
const VIOLET_GAIN = 0.70775;

export class Noise {
  private state: number;
  // Paul Kellet refined pink-filter accumulators.
  private b0 = 0;
  private b1 = 0;
  private b2 = 0;
  private b3 = 0;
  private b4 = 0;
  private b5 = 0;
  private b6 = 0;
  // brown leaky-integrator memory.
  private brownState = 0;
  // previous gain-normalized pink / white, for the blue / violet first differences.
  private pinkPrev = 0;
  private whitePrev = 0;

  constructor(seed: number) {
    // Avoid the zero fixed-point of xorshift; keep it a 32-bit uint.
    this.state = (seed | 0) || 0x9e3779b9;
  }

  /**
   * One colored sample. `color` 0..1 morphs brown→pink→white→blue→violet (white at
   * 0.5). Output RMS ≈ white at every position; transient peaks may exceed ±1 for
   * some colors (we match loudness, not peak — downstream level + filter absorb it).
   */
  next(color: number): number {
    // White draw — generator unchanged from the original implementation.
    let x = this.state;
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    this.state = x >>> 0;
    const white = (this.state / 0xffffffff) * 2 - 1; // [-1, 1)

    // pink — Paul Kellet refined filter (-3 dB/oct).
    this.b0 = 0.99886 * this.b0 + white * 0.0555179;
    this.b1 = 0.99332 * this.b1 + white * 0.0750759;
    this.b2 = 0.96900 * this.b2 + white * 0.1538520;
    this.b3 = 0.86650 * this.b3 + white * 0.3104856;
    this.b4 = 0.55000 * this.b4 + white * 0.5329522;
    this.b5 = -0.7616 * this.b5 - white * 0.0168980;
    const pinkRaw = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
    this.b6 = white * 0.115926;
    const pink = pinkRaw * PINK_GAIN;

    // brown — leaky integrator (-6 dB/oct), bounded so DC can't run away.
    this.brownState = (this.brownState + 0.02 * white) / 1.02;
    const brown = this.brownState * BROWN_GAIN;

    // blue / violet — first differences (+6 dB/oct each) of normalized pink / white.
    const blue = (pink - this.pinkPrev) * BLUE_GAIN;
    const violet = (white - this.whitePrev) * VIOLET_GAIN;
    this.pinkPrev = pink;
    this.whitePrev = white;

    // Crossfade the two anchors bracketing `color` on the 5-point axis
    // (brown@0, pink@0.25, white@0.5, blue@0.75, violet@1). The symmetric
    // (1-t)·A + t·B form is bit-exact at the joins, so color 0.5 returns white.
    // Non-finite color → white (defensive; ParamSlot already pre-clamps).
    const c = Number.isFinite(color) ? (color < 0 ? 0 : color > 1 ? 1 : color) : 0.5;
    if (c <= 0.25) { const t = c / 0.25;          return (1 - t) * brown + t * pink; }
    if (c <= 0.5)  { const t = (c - 0.25) / 0.25; return (1 - t) * pink  + t * white; }
    if (c <= 0.75) { const t = (c - 0.5) / 0.25;  return (1 - t) * white + t * blue; }
    const t = (c - 0.75) / 0.25;                  return (1 - t) * blue  + t * violet;
  }
}
