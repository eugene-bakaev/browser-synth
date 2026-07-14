// Per-module wave-shape preview (spec 2026-06-19): the bipolar samples each
// synth2 oscillator / LFO actually generates, drawn from the REAL kernel DSP
// (MorphOscillator for oscs, Lfo.wave for LFOs) at a fixed representative
// display pitch. Pure data — no canvas, no audio context. This is the ONLY
// place the UI touches kernel DSP; the Vue layer just paints the buffer.

import { MorphOscillator } from '../kernel/MorphOscillator';
import { Lfo } from '../kernel/Lfo';
import { ParamSlot } from '../kernel/ParamSlot';
import { PARAM_INDEX } from '../kernel/params';
import { SYNTH2_DESCRIPTORS } from '@fiddle/shared';
import type { Synth2ParamDescriptor } from '@fiddle/shared';

/** Samples captured = polyline points drawn. */
export const PREVIEW_POINTS = 512;
/** Cycles shown so the thumbnail reads as a repeating "wave". */
export const PREVIEW_CYCLES = 3;
/** Nominal sample rate — the preview is a drawing, not the audio context. */
export const PREVIEW_SR = 48000;

/** Samples advanced before capture so the triangle leaky-integrator settles. */
const WARMUP_SAMPLES = 1024;
/**
 * Whole-sample period for the oscillator capture. The naive increment
 * PREVIEW_CYCLES / PREVIEW_POINTS gives a 170.67-sample period, which lands the
 * final cycle's saw-fall exactly on the captured buffer's closing boundary —
 * outside the window. Flooring to a whole sample count (170) makes PREVIEW_CYCLES
 * periods span 510 ≤ PREVIEW_POINTS samples, so every discontinuity lands on an
 * interior sample and the thumbnail shows complete cycles. The PolyBLEP edge is
 * then anti-aliased across ~2 samples (correct band-limiting), so consumers must
 * treat a fall as a 1–2 sample event. Display pitch shifts ~0.4% (281 → 282 Hz),
 * negligible against the band-limiting analysis in the spec.
 */
const SAMPLES_PER_CYCLE = Math.floor(PREVIEW_POINTS / PREVIEW_CYCLES);
/** Pitch fed to the oscillator so one cycle spans SAMPLES_PER_CYCLE samples. */
const DISPLAY_FREQ = PREVIEW_SR / SAMPLES_PER_CYCLE;

// Real descriptors give the preview slots the engine's true min/max/taper, so
// ParamSlot's clamp matches production. We override `default` with the desired
// value: the ctor sets current=target=default, so next() returns it with no
// smoother ramp (no smoother warm-up needed). All three oscs share identical
// descriptor ranges, so osc1's descriptors serve every oscillator.
const OSC_MORPH = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.morph']];
const OSC_PW = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.pulseWidth']];
const OSC_COARSE = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.coarse']];
const OSC_FINE = SYNTH2_DESCRIPTORS[PARAM_INDEX['osc1.fine']];

const LFO_RATE = SYNTH2_DESCRIPTORS[PARAM_INDEX['lfo1.rate']];
const LFO_SHAPE = SYNTH2_DESCRIPTORS[PARAM_INDEX['lfo1.shape']];
const LFO_MODE = SYNTH2_DESCRIPTORS[PARAM_INDEX['lfo1.mode']];
// Fixed seed so the random thumbnail never flickers between redraws.
const LFO_PREVIEW_SEED = 0x1234abcd;
// Rate that spans PREVIEW_CYCLES cycles across PREVIEW_POINTS samples (≈281 Hz).
const LFO_PREVIEW_RATE = (PREVIEW_CYCLES * PREVIEW_SR) / PREVIEW_POINTS;

// NB: overriding `default` bypasses ParamSlot.setBase's NaN clamp, but next()'s
// own output clamp (non-finite → desc.min) keeps a garbage value finite — that
// clamp, not the constructor, is what makes the NaN-hardening case safe here.
const slotWithValue = (desc: Synth2ParamDescriptor, value: number): ParamSlot =>
  new ParamSlot({ ...desc, default: value }, PREVIEW_SR);

/**
 * Bipolar samples (≈ −1..+1) of one oscillator's morphed shape over
 * ~PREVIEW_CYCLES cycles, produced by the real MorphOscillator (PolyBLEP edges,
 * leaky-integrator triangle). Length === PREVIEW_POINTS.
 */
export function renderOscShape(morph: number, pulseWidth: number): Float32Array {
  const osc = new MorphOscillator(
    slotWithValue(OSC_MORPH, morph),
    slotWithValue(OSC_PW, pulseWidth),
    slotWithValue(OSC_COARSE, 0),
    slotWithValue(OSC_FINE, 0),
    PREVIEW_SR,
  );
  // Settle the triangle integrator.
  for (let i = 0; i < WARMUP_SAMPLES; i++) osc.next(DISPLAY_FREQ);
  // Phase-align: start capture at a wrap (phase ≈ 0) so the drawing doesn't
  // slide horizontally as the user sweeps morph. A wrap always occurs within one
  // period (coarse/fine are fixed at 0 ⇒ DISPLAY_FREQ is a fixed small dt); the
  // bound is a defensive cap so a future caller threading a degenerate pitch
  // (NaN / zero dt) can't spin forever — matching the kernel's I4 posture.
  for (let i = 0; i <= SAMPLES_PER_CYCLE && !osc.wrapped; i++) osc.next(DISPLAY_FREQ);
  const out = new Float32Array(PREVIEW_POINTS);
  for (let i = 0; i < PREVIEW_POINTS; i++) out[i] = osc.next(DISPLAY_FREQ);
  return out;
}

/**
 * Bipolar samples of one LFO's morphed shape over PREVIEW_CYCLES cycles,
 * produced by the engine's own Lfo.wave (naive by design ⇒ exact at any
 * sampling). Length === PREVIEW_POINTS.
 */
export function renderLfoShape(
  shape: number,
  mode: 'off' | 's&h' | 'smooth' = 'off',
): Float32Array {
  const out = new Float32Array(PREVIEW_POINTS);
  if (mode === 'off') {
    for (let i = 0; i < PREVIEW_POINTS; i++) {
      const phase = ((i / PREVIEW_POINTS) * PREVIEW_CYCLES) % 1;
      out[i] = Lfo.wave(shape, phase);
    }
    return out;
  }
  // S&H / Smooth: drive the real kernel Lfo (single source of truth for the DSP)
  // at a fixed rate + seed so PREVIEW_CYCLES random steps fill the thumbnail.
  const lfo = new Lfo(
    slotWithValue(LFO_RATE, LFO_PREVIEW_RATE),
    slotWithValue(LFO_SHAPE, 0),
    slotWithValue(LFO_MODE, mode === 's&h' ? 1 : 2),
    PREVIEW_SR,
    LFO_PREVIEW_SEED,
  );
  for (let i = 0; i < PREVIEW_POINTS; i++) out[i] = lfo.next();
  return out;
}
