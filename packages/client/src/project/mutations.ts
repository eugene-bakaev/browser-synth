import type { ProjectTrack } from './types';
import { freshStep } from './factory';

export function clearTrack(track: ProjectTrack, patternLength: number): void {
  for (let i = 0; i < patternLength; i++) {
    Object.assign(track.steps[i], freshStep());
  }
}

export function shiftTrack(track: ProjectTrack, direction: 'left' | 'right', patternLength: number): void {
  if (patternLength <= 1) return;
  // Rotate only the [0, patternLength) window in place, preserving the reactive
  // Step object identities (Object.assign into existing slots).
  const window = track.steps.slice(0, patternLength).map(s => ({ ...s }));
  for (let i = 0; i < patternLength; i++) {
    const src = direction === 'left'
      ? window[(i + 1) % patternLength]
      : window[(i - 1 + patternLength) % patternLength];
    Object.assign(track.steps[i], src);
  }
}

export function fillTrack(track: ProjectTrack, interval: number, patternLength: number): void {
  if (interval <= 0) return; // guard against modulo-by-zero (UI only offers 1/2/4/8)
  for (let i = 0; i < patternLength; i++) {
    if (i % interval === 0) {
      const step = track.steps[i];
      step.note = 'C';
      step.muted = false;
      step.velocity = 0.8;
      step.isChord = false;
      step.chordType = 'maj';
    }
  }
}
