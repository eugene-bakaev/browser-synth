import { freshProject, type Project } from '@fiddle/shared';

// A deterministic-structure project for the sequencer-correctness checks.
// Three enabled tracks; track 2 is polymeter (patternLength 12) so it wraps
// against the 16-step bar. Drum engines only → sharp, unambiguous onsets.
export function buildSequencerFixture(): Project {
  const p = freshProject();
  p.bpm = 120;
  for (let i = 0; i < p.tracks.length; i++) p.tracks[i].enabled = i < 3;

  const put = (track: number, step: number) => {
    p.tracks[track].steps[step] = { ...p.tracks[track].steps[step], note: 'C', muted: false };
  };

  // Track 0 — kick2, four-on-the-floor (steps 0,4,8,12), patternLength 16.
  p.tracks[0].engineType = 'kick2';
  p.tracks[0].patternLength = 16;
  for (const s of [0, 4, 8, 12]) put(0, s);

  // Track 1 — clap2, backbeat (steps 4,12), patternLength 16.
  p.tracks[1].engineType = 'clap2';
  p.tracks[1].patternLength = 16;
  for (const s of [4, 12]) put(1, s);

  // Track 2 — hat2, single hit at local step 0, patternLength 12 (polymeter):
  // fires at absolute steps 0,12,24,36,... .
  p.tracks[2].engineType = 'hat2';
  p.tracks[2].patternLength = 12;
  put(2, 0);

  return p;
}
