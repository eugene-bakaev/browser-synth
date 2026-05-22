import { NOTES, noteToFreq } from './notes';

export const CHORD_FORMULAS: Record<string, number[]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  min7: [0, 3, 7, 10],
  sus4: [0, 5, 7],
  dim: [0, 3, 6],
  '9': [0, 4, 7, 10, 14],
};

export function resolveChordFreqs(root: string, type: string, octave: number): number[] {
  const baseIndex = NOTES.indexOf(root);
  if (baseIndex === -1) return [];

  const formula = CHORD_FORMULAS[type] || CHORD_FORMULAS.maj;
  return formula.map(offset => {
    const offsetIndex = baseIndex + offset;
    const noteName = NOTES[offsetIndex % 12];
    const noteOctave = octave + Math.floor(offsetIndex / 12);
    return noteToFreq(noteName, noteOctave);
  });
}
