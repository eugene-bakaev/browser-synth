export type KnobFormat = 'hz' | 'ms' | 'percent' | 'cents' | 'octave' | 'octaveSwitch' | 'ratio' | 'db';

/** Render a knob's numeric value as its readout string. Extracted from Knob.vue
 *  so it is unit-testable (mirrors ui/knobTaper.ts). When `labels` is given and
 *  round(value) indexes into it, the label wins over `format` (used by the
 *  tempo-synced LFO Rate knob, whose value is a division index). */
export function formatKnobValue(
  format: KnobFormat | undefined,
  value: number,
  labels?: readonly string[],
): string {
  // Defensive: a param leaf missing from an old/partial snapshot can arrive as
  // undefined/null/NaN before heal — never let it throw and take down the panel.
  if (value === undefined || value === null || Number.isNaN(value)) return '';

  if (labels) {
    const label = labels[Math.round(value)];
    if (label !== undefined) return label;
  }

  if (!format) return value.toString();

  switch (format) {
    case 'hz':
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
      // Part A: below 10 Hz the whole-number readout collapsed the LFO's usable
      // sub-1 Hz range to "0Hz"/"1Hz". Show up to 2 decimals, trailing zeros
      // trimmed. cutoff (min 20 Hz) never reaches this branch.
      if (value < 10) return `${parseFloat(value.toFixed(2))}Hz`;
      return Math.round(value) + 'Hz';
    case 'ms':
      // Always render ms — switching to "s" past 1.0 looked like the value
      // dropped ("990ms" → "1.00s") even though it went up. Max range here
      // is 5s = "5000ms" (6 chars), still fits the 48px value cell.
      return Math.round(value * 1000) + 'ms';
    case 'percent':
      return Math.round(value * 100) + '%';
    case 'cents': {
      const prefix = value > 0 ? '+' : '';
      return `${prefix}${value}c`;
    }
    case 'octave': {
      const rounded = Number(value.toFixed(1));
      if (rounded === 0) return '0';
      // Arrow shows sweep direction at a glance — ↑ filter opens, ↓ filter closes.
      // Magnitude is in octaves, but the label already implies it; unit text omitted
      // to keep the value cell narrow and stop layout shifts on knob turn.
      return rounded > 0 ? `↑${rounded}` : `↓${Math.abs(rounded)}`;
    }
    case 'octaveSwitch': {
      // The leaf is semitones; the OCTAVE switch steps it in whole octaves, so
      // render as signed octaves. A legacy off-octave value rounds to nearest.
      const oct = Math.round(value / 12);
      if (oct === 0) return '0';
      return oct > 0 ? `+${oct}` : `${oct}`; // negative already carries '-'
    }
    case 'ratio':
      return value.toFixed(1);
    case 'db': {
      // Knob value is the slider position 0..1; we render the perceptual dB
      // it represents. -54..+6 dB throw with unity at slider 0.9. The audio-
      // side linear gain conversion lives in useSynth.sliderToLinearGain —
      // keep them in sync if the range changes.
      if (value <= 0) return '-∞ dB';
      const db = -54 + value * 60;
      const prefix = db > 0 ? '+' : '';
      return prefix + db.toFixed(1) + ' dB';
    }
    default:
      return value.toString();
  }
}
