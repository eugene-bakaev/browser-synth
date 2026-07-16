import { describe, it, expect } from 'vitest';
import { renderEngine, noteToFreq, ENGINE_IDS } from './engine';
import { analyzeEnvelope } from '../analyze/envelope';
import { analyzePitch } from '../analyze/pitch';
import { analyzeHealth } from '../analyze/health';

describe('noteToFreq', () => {
  it('maps note names to equal-temperament frequencies', () => {
    expect(noteToFreq('A4')).toBeCloseTo(440, 2);
    expect(noteToFreq('C4')).toBeCloseTo(261.63, 1);
    expect(noteToFreq('C#3')).toBeCloseTo(138.59, 1);
    expect(noteToFreq('Eb2')).toBeCloseTo(77.78, 1);
    expect(() => noteToFreq('H4')).toThrow(/note/i);
  });
});

describe('renderEngine', () => {
  it('renders a synth2 note: audible, in tune, healthy', () => {
    const clip = renderEngine({
      engine: 'synth2',
      notes: [{ time: 0, note: 'A3', duration: 0.5 }],
      seconds: 1,
    });
    expect(clip.samples.length).toBe(48000);
    const health = analyzeHealth(clip);
    expect(health.nonFiniteSamples).toBe(0);
    expect(health.flags).not.toContain('MOSTLY_SILENT');
    const env = analyzeEnvelope(clip);
    expect(env.onsets.length).toBeGreaterThanOrEqual(1);
    expect(env.onsets[0]).toBeLessThan(0.03);
    const pitch = analyzePitch(clip);
    expect(pitch.medianF0).not.toBeNull();
    // default patch may be detuned/rich; just require the right octave region
    expect(pitch.medianF0!).toBeGreaterThan(180);
    expect(pitch.medianF0!).toBeLessThan(260);
  });

  it('places a kick2 hit at the scheduled time', () => {
    const clip = renderEngine({
      engine: 'kick2',
      notes: [{ time: 0.25, note: 'C2', duration: 0.1 }],
      seconds: 1,
    });
    const env = analyzeEnvelope(clip);
    expect(env.onsets.length).toBe(1);
    expect(env.onsets[0]).toBeGreaterThan(0.23);
    expect(env.onsets[0]).toBeLessThan(0.27);
  });

  it('every engine renders its default patch without NaN or total silence', () => {
    for (const engine of ENGINE_IDS) {
      const clip = renderEngine({
        engine,
        notes: [{ time: 0, note: 'A3', duration: 0.3 }],
        seconds: 0.8,
      });
      const health = analyzeHealth(clip);
      expect(health.nonFiniteSamples, engine).toBe(0);
      expect(health.flags, engine).not.toContain('MOSTLY_SILENT');
    }
  });

  it('applies param overrides and rejects unknown keys with the valid list', () => {
    // filter.cutoff must exist on synth2 (descriptor wire key)
    const dark = renderEngine({
      engine: 'synth2',
      params: { 'filter.cutoff': 200 },
      notes: [{ time: 0, note: 'A3', duration: 0.4 }],
      seconds: 1,
    });
    expect(analyzeHealth(dark).flags).not.toContain('MOSTLY_SILENT');
    expect(() =>
      renderEngine({ engine: 'synth2', params: { nonsense: 1 }, notes: [], seconds: 0.1 }),
    ).toThrow(/Unknown param 'nonsense'.*filter\.cutoff/s);
  });

  it('wires synth2 matrix routes and rejects them for other engines', () => {
    const wobble = renderEngine({
      engine: 'synth2',
      matrix: [{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.8 }],
      notes: [{ time: 0, note: 'A2', duration: 1.5 }],
      seconds: 2,
    });
    expect(analyzeHealth(wobble).nonFiniteSamples).toBe(0);
    expect(() =>
      renderEngine({
        engine: 'kick2',
        matrix: [{ source: 'lfo1', dest: 'filter.cutoff', amount: 0.5 }],
        notes: [],
        seconds: 0.1,
      }),
    ).toThrow(/matrix/i);
  });
});
