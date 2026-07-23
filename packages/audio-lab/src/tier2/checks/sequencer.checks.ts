import type { Project } from '@fiddle/shared';
import { stepDuration } from '@fiddle/client/src/sequencer/schedule';

// Grid times (seconds) at which a solo render of `trackIndex` should show an
// onset: every firing (note && !muted) step in the render window, per-track
// modulo applied. Pure — the ground truth the browser render is checked against.
export function expectedOnsets(project: Project, bars: number, trackIndex: number): number[] {
  const track = project.tracks[trackIndex];
  const tick = stepDuration(project.bpm);
  const totalSteps = bars * 16;
  const times: number[] = [];
  for (let k = 0; k < totalSteps; k++) {
    const step = track.steps[k % track.patternLength];
    if (step.note && !step.muted) times.push(k * tick);
  }
  return times;
}
