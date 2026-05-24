import type { ProjectTrack } from './types';
import { freshStep } from './factory';

export function clearTrack(track: ProjectTrack): void {
  for (let i = 0; i < track.steps.length; i++) {
    Object.assign(track.steps[i], freshStep());
  }
}

export function shiftTrack(track: ProjectTrack, direction: 'left' | 'right'): void {
  if (direction === 'left') {
    const first = track.steps.shift();
    if (first !== undefined) track.steps.push(first);
  } else {
    const last = track.steps.pop();
    if (last !== undefined) track.steps.unshift(last);
  }
}

export function fillTrack(track: ProjectTrack, interval: number): void {
  for (let i = 0; i < track.steps.length; i++) {
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
