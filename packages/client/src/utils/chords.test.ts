import { describe, it, expect } from 'vitest';
import { resolveChordFreqs } from './chords';
import { noteToFreq } from './notes';

describe('chords utility', () => {
  it('should return empty list for invalid root note', () => {
    expect(resolveChordFreqs('X', 'maj', 4)).toEqual([]);
  });

  it('should resolve C maj at octave 4 correctly', () => {
    const freqs = resolveChordFreqs('C', 'maj', 4);
    expect(freqs).toHaveLength(3);
    expect(freqs[0]).toBeCloseTo(noteToFreq('C', 4)); // C4
    expect(freqs[1]).toBeCloseTo(noteToFreq('E', 4)); // E4
    expect(freqs[2]).toBeCloseTo(noteToFreq('G', 4)); // G4
  });

  it('should handle octave wrapping (e.g. B4 major)', () => {
    const freqs = resolveChordFreqs('B', 'maj', 4);
    // B4, D#5, F#5
    expect(freqs).toHaveLength(3);
    expect(freqs[0]).toBeCloseTo(noteToFreq('B', 4));
    expect(freqs[1]).toBeCloseTo(noteToFreq('D#', 5));
    expect(freqs[2]).toBeCloseTo(noteToFreq('F#', 5));
  });

  it('should fall back to major formula if chord type is invalid', () => {
    const freqs = resolveChordFreqs('C', 'invalid_type', 4);
    expect(freqs).toHaveLength(3);
    expect(freqs[0]).toBeCloseTo(noteToFreq('C', 4));
  });

  it('should support 7th, maj7, min7, sus4, dim, and 9th chords', () => {
    expect(resolveChordFreqs('C', '7', 4)).toHaveLength(4);
    expect(resolveChordFreqs('C', 'maj7', 4)).toHaveLength(4);
    expect(resolveChordFreqs('C', 'min7', 4)).toHaveLength(4);
    expect(resolveChordFreqs('C', 'sus4', 4)).toHaveLength(3);
    expect(resolveChordFreqs('C', 'dim', 4)).toHaveLength(3);
    expect(resolveChordFreqs('C', '9', 4)).toHaveLength(5);
  });
});
