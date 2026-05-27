const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function noteToFreq(note: string, octave: number): number {
  const index = NOTES.indexOf(note);
  if (index === -1) return 0;
  // A4 = 440Hz, which is index 9 at octave 4
  const n = index + (octave * 12) - (4 * 12 + 9);
  return 440 * Math.pow(2, n / 12);
}

export { NOTES };
