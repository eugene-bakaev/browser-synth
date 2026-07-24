import { describe, it, expect } from 'vitest';
import { freshProject } from '../project';
import { stepDuration, resolveStepTriggers } from './schedule';
import { noteToFreq } from '../utils/notes';

function bareProject() {
  const p = freshProject();
  for (const t of p.tracks) t.enabled = false; // start clean
  return p;
}

describe('stepDuration', () => {
  it('is a 16th note', () => {
    expect(stepDuration(120)).toBeCloseTo((60 / 120) / 4, 12); // 0.125s
  });
});

describe('resolveStepTriggers', () => {
  it('fires a mono synth2 note as a single frequency', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'synth2'; t.engines.synth2.mode = 'mono'; t.patternLength = 16;
    t.steps[0] = { ...t.steps[0], note: 'C', octave: 4, length: 2, velocity: 0.5, muted: false };
    const evs = resolveStepTriggers(p, 0, 3.0);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ trackIndex: 0, freq: noteToFreq('C', 4), time: 3.0, velocity: 0.5 });
    expect(evs[0].duration).toBeCloseTo(2 * stepDuration(p.bpm), 12);
  });

  it('fires a poly synth2 note as a chord array', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'synth2'; t.engines.synth2.mode = 'poly';
    t.steps[0] = { ...t.steps[0], note: 'C', octave: 4, chordType: 'min', muted: false };
    const [ev] = resolveStepTriggers(p, 0, 0);
    expect(Array.isArray(ev.freq)).toBe(true);
    expect((ev.freq as number[]).length).toBe(3); // min triad
  });

  it('fires a mono v1 synth note as a single frequency', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'synth'; t.engines.synth.mode = 'mono'; t.patternLength = 16;
    t.steps[0] = { ...t.steps[0], note: 'C', octave: 4, length: 2, velocity: 0.5, muted: false };
    const evs = resolveStepTriggers(p, 0, 3.0);
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ trackIndex: 0, freq: noteToFreq('C', 4), time: 3.0, velocity: 0.5 });
    expect(evs[0].duration).toBeCloseTo(2 * stepDuration(p.bpm), 12);
  });

  it('fires a poly v1 synth note as a chord array', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'synth'; t.engines.synth.mode = 'poly';
    t.steps[0] = { ...t.steps[0], note: 'C', octave: 4, chordType: 'min', muted: false };
    const [ev] = resolveStepTriggers(p, 0, 0);
    expect(Array.isArray(ev.freq)).toBe(true);
    expect((ev.freq as number[]).length).toBe(3); // min triad
  });

  it('fires drums as freq 0, duration 0', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'kick2';
    t.steps[0] = { ...t.steps[0], note: 'C', muted: false };
    expect(resolveStepTriggers(p, 0, 1.5)[0]).toMatchObject({ trackIndex: 0, freq: 0, duration: 0, time: 1.5 });
  });

  it('skips disabled tracks, rests (note null), and muted steps', () => {
    const p = bareProject();
    p.tracks[0].engineType = 'kick2'; // disabled
    p.tracks[1].enabled = true; p.tracks[1].engineType = 'kick2';
    p.tracks[1].steps[0] = { ...p.tracks[1].steps[0], note: null };          // rest
    p.tracks[1].steps[1] = { ...p.tracks[1].steps[1], note: 'C', muted: true }; // muted
    expect(resolveStepTriggers(p, 0, 0)).toHaveLength(0);
    expect(resolveStepTriggers(p, 1, 0)).toHaveLength(0);
  });

  it('applies per-track modulo (polymeter)', () => {
    const p = bareProject();
    const t = p.tracks[0];
    t.enabled = true; t.engineType = 'hat2'; t.patternLength = 3;
    t.steps[0] = { ...t.steps[0], note: 'C', muted: false };
    expect(resolveStepTriggers(p, 0, 0)).toHaveLength(1); // 0 % 3 == 0
    expect(resolveStepTriggers(p, 3, 0)).toHaveLength(1); // 3 % 3 == 0
    expect(resolveStepTriggers(p, 1, 0)).toHaveLength(0); // 1 % 3 == 1 (rest)
  });
});
