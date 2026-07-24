// Pure step->trigger walk shared by live playback (the AudioEngine onStep
// callback that sequencer.start drives) and the offline Tier-2 harness, so the
// two can never drift. No AudioContext, no engine objects, no Vue —
// resolveStepTriggers is a pure function of project state. Mirrors the mapping
// AudioEngine.onStep used to inline (per-track modulo, note/mute gating,
// poly-chord vs mono vs fire-and-forget drums).
import type { Project } from '../project';
import { noteToFreq } from '../utils/notes';
import { resolveChordFreqs } from '../utils/chords';

export interface TriggerEvent {
  trackIndex: number;
  freq: number | number[]; // drums -> 0; synth mono -> Hz; poly -> chord Hz[]
  duration: number;        // drums -> 0; synth -> step.length * stepDuration(bpm)
  time: number;            // seconds on the ctx clock
  velocity: number;
}

/** A 16th-note step, in seconds, at the given tempo. */
export function stepDuration(bpm: number): number {
  return (60 / bpm) / 4;
}

/** Triggers due at one absolute step, for every enabled track. The live path
 *  keeps its own `state.engines[i]?` existence guard; this function only knows
 *  the project. */
export function resolveStepTriggers(project: Project, absoluteStep: number, time: number): TriggerEvent[] {
  const events: TriggerEvent[] = [];
  const tick = stepDuration(project.bpm);
  for (let i = 0; i < project.tracks.length; i++) {
    const track = project.tracks[i];
    if (!track.enabled) continue;
    const step = track.steps[absoluteStep % track.patternLength];
    if (!step.note || step.muted) continue;

    const type = track.engineType;
    if (type === 'synth' || type === 'synth2') {
      const mode = type === 'synth' ? track.engines.synth.mode : track.engines.synth2.mode;
      const duration = step.length * tick;
      const freq = mode === 'poly'
        ? resolveChordFreqs(step.note, step.chordType || 'maj', step.octave)
        : noteToFreq(step.note, step.octave);
      events.push({ trackIndex: i, freq, duration, time, velocity: step.velocity });
    } else {
      // Drums are fire-and-forget: pitch/decay come from the engine's knobs.
      events.push({ trackIndex: i, freq: 0, duration: 0, time, velocity: step.velocity });
    }
  }
  return events;
}
