//
// The swappable filter seam (spec §6.3). ClassicFilter (I2c-2) is the only
// implementation today; MorphFilter arrives in I3 behind this same interface,
// selected per voice by a future `filter.model` enum. The Voice owns the
// cutoff/resonance ParamSlots and passes their per-sample values in, so a
// filter never reaches for global state — it just transforms one sample.
//
export interface FilterModule {
  /** Note-on / voice-steal: clear internal state. */
  reset(): void;
  /** Select the output flavour (ClassicFilter: 0 = lp, 1 = bp, 2 = hp). */
  setType(type: number): void;
  /** One sample. cutoffHz is the final cutoff (keytrack + env already applied);
   *  resonance is 0..1; morph is the 0..2 LP→BP→HP blend used by MorphFilter
   *  (ClassicFilter ignores it and uses its block-set type). Returns the output. */
  process(input: number, cutoffHz: number, resonance: number, morph: number): number;
}
