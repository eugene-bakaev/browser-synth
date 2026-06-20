//
// Morph filter (spec §5.3, I3d) — the 2nd FilterModule behind the shared seam.
// One SvfCore; a continuous `morph` 0..2 equal-power crossfades adjacent outputs
// (0 = LP, 1 = BP, 2 = HP). `morph` arrives per-sample (it is a modulatable
// ParamSlot), so the matrix can sweep the filter architecture. setType is inert —
// morph has no discrete type. Pure DSP, no allocation after construction.
//
import type { FilterModule } from './FilterModule';
import { SvfCore } from './SvfCore';

export class MorphFilter implements FilterModule {
  private readonly svf: SvfCore;

  constructor(sampleRate: number) {
    this.svf = new SvfCore(sampleRate);
  }

  reset(): void {
    this.svf.reset();
  }

  // No discrete type — morph is continuous. Kept for the uniform FilterModule shape.
  setType(_type: number): void {}

  process(input: number, cutoffHz: number, resonance: number, morph: number, drive = 0): number {
    const m = morph < 0 ? 0 : morph > 2 ? 2 : morph;
    this.svf.tick(input, cutoffHz, resonance, drive);
    let a: number, b: number, frac: number;
    if (m <= 1) { a = this.svf.low; b = this.svf.band; frac = m; }       // LP → BP
    else        { a = this.svf.band; b = this.svf.high; frac = m - 1; }  // BP → HP
    const g = frac * (Math.PI / 2);
    return Math.cos(g) * a + Math.sin(g) * b;                            // equal-power
  }
}
