import { describe, it, expect } from 'vitest';
import { engineLabel } from './engineLabel';

describe('engineLabel', () => {
  it('labels a mono synth', () => {
    expect(engineLabel('synth', 'mono')).toBe('SYNTH · MONO');
  });

  it('labels a poly synth', () => {
    expect(engineLabel('synth', 'poly')).toBe('SYNTH · POLY');
  });

  it('treats a synth with no mode as mono', () => {
    expect(engineLabel('synth')).toBe('SYNTH · MONO');
  });

  it('uppercases the drum engines (no sub-mode)', () => {
    expect(engineLabel('kick')).toBe('KICK');
    expect(engineLabel('hat')).toBe('HAT');
    expect(engineLabel('snare')).toBe('SNARE');
    expect(engineLabel('clap')).toBe('CLAP');
  });
});
