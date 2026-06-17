//
// Classic discrete LP/BP/HP filter (spec §5.3) — a thin selector over one
// SvfCore (which computes all three outputs each sample). `type` is set at the
// block boundary from the `filter.type` enum (lp=0, bp=1, hp=2).
//
import type { FilterModule } from './FilterModule';
import { SvfCore } from './SvfCore';

export class ClassicFilter implements FilterModule {
  private type = 0; // 0 lp, 1 bp, 2 hp
  private readonly svf: SvfCore;

  constructor(sampleRate: number) {
    this.svf = new SvfCore(sampleRate);
  }

  /** Read-only view of the selected type (for tests/diagnostics). */
  get currentType(): number {
    return this.type;
  }

  reset(): void {
    this.svf.reset();
  }

  setType(type: number): void {
    const t = Math.round(type);
    this.type = t < 0 ? 0 : t > 2 ? 2 : t;
  }

  process(input: number, cutoffHz: number, resonance: number, _morph = 0): number {
    this.svf.tick(input, cutoffHz, resonance);
    return this.type === 0 ? this.svf.low : this.type === 1 ? this.svf.band : this.svf.high;
  }
}
