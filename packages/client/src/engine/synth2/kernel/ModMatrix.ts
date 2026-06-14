//
// Per-voice mod matrix (spec §5.6). The ONLY writer of ParamSlot.mod. Each
// sample: clear every slot's mod, then for each active route add
// source × amount into the destination slot's mod. Scaling/taper/clamp is the
// slot's job (ParamSlot.next), not ours — keep this a pure multiply-add so it
// stays WASM-shaped (kernel ABI §6.7: no allocation, no polymorphic calls).
//
// Fixed 8 slots. src[i] = MOD_SOURCES index (into the per-sample sources[]
// array). dest[i] = destination slot index, or -1 for 'none'. amt[i] bipolar.

import { MATRIX_SLOTS } from './params';

interface ModTarget { mod: number }

export class ModMatrix {
  private readonly src = new Int32Array(MATRIX_SLOTS);
  private readonly dest = new Int32Array(MATRIX_SLOTS).fill(-1);
  private readonly amt = new Float32Array(MATRIX_SLOTS);

  /** Configure route `i` (block-boundary). destSlot < 0 ⇒ inactive (none). */
  setSlot(i: number, srcIndex: number, destSlot: number, amount: number): void {
    this.src[i] = srcIndex;
    this.dest[i] = destSlot;
    this.amt[i] = amount;
  }

  /** Clear, then accumulate into the destination slots. Called once per sample. */
  apply(slots: ModTarget[], sources: Float32Array): void {
    for (let i = 0; i < slots.length; i++) slots[i].mod = 0;
    for (let s = 0; s < MATRIX_SLOTS; s++) {
      const d = this.dest[s];
      if (d < 0) continue;
      const a = this.amt[s];
      if (a === 0) continue;
      slots[d].mod += sources[this.src[s]] * a;
    }
  }
}
