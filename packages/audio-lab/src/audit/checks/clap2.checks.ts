// clap2 audit check table. Descriptor ground truth (packages/shared/src/engines/clap2.ts):
// tone 500-3000 def 1100 · spread 0.005-0.04 def 0.022 · bursts 2-5 def 4 ·
// body 0.002-0.03 def 0.005 · room 0.05-0.8 def 0.14 · mix 0-1 def 0.30 · level 0-1 def 0.8.
//
// CALIBRATED (Task 7), then RE-CALIBRATED for the 2026-07-21 voicing re-voice
// (feat/clap2-voicing: non-uniform amplitude-decaying jittered slap train, 0.15ms
// attack, broadened Q-0.7 bandpass + HF attack injection, dropped room-gain floor,
// tuned defaults above). The re-voice shifted two decaySeconds checks — the tuned
// defaults' shorter room (0.14) + the new roomGain=mix mapping make decaySeconds
// room-tail-dominated at the default/low mix, so spread and body stop moving it there:
//  - spread.dir: at the default the burst train's share of the -40dB decay crossing
//    is masked by the room tail (measured delta 0.000). Wider spread's real, robust
//    effect under the re-voice is onset SEPARATION. Switched metric decaySeconds ->
//    onsetCount with a `mix: 0` override (room off so the detector resolves the slaps):
//    onsetCount 1 (spread 0.006) -> 4 (spread 0.038), direction up, minDelta 1. NB the
//    old decaySeconds framing no longer holds: the Task-2 amplitude decay makes the
//    first slap dominant, so wider spread actually SHORTENS the peak-relative decay.
//  - body.dir: at the drafted mix:0.1 the room tail dominates decaySeconds (delta
//    0.005). Moved the override to `mix: 0` (pure burst) where body directly sets the
//    per-slap decay: decaySeconds 0.030 (body 0.003) -> 0.185 (body 0.028), delta
//    +0.155, direction 'change', minDelta raised 0.02 -> 0.05 to match the magnitude.
//  - onset.separation (NEW, absolute onsetCount>=2 at mix:0): the central win — the
//    tuned default clap resolves as >=2 distinct slaps (measured 3), no longer the one
//    continuous blob the pre-re-voice train produced ("always 1"). Locks the F8 fix.
//  Unchanged and still green under the re-voice: fingerprint.peak, tone.dir, bursts.dir
//  (rmsDb, pure-burst — onsetCount would not move for bursts, so rmsDb it stays),
//  room.dir (3.0s window; minDelta 1.0 for the +2.315s reverberant-tail effect),
//  mix.dir, level.dir.
//  - No CLIPPING is observed on any clap2 leg (PERC stays ['MOSTLY_SILENT'] only,
//    unlike kick2/snare2); the re-voice keeps that (peaks well under 0dBFS). clap2's
//    voicing is no longer "untouched": the 2026-07-21 re-voice landed and was
//    ear-approved (BACKLOG F8) — a distinct, brighter clap, though not a strict 909.
//  2026-07-22 F8 follow-up (feat/clap2-followups): a fixed 2.5kHz 1-pole LP on the
//  BODY path only tames the broad bandpass's white-noise HF skirt (meanCentroidHz
//  7677 -> 4644); the bright attack-snap (HF-inject path) is untouched. Removing that
//  HF energy dropped the default peak -13.5 -> -16.5dB, so fingerprint.peak's floor
//  moved -15 -> -18 (still audible). tone.dir/onset checks unaffected. Ear-approved.
//  2026-07-22 loudness parity (feat/clap2-loudness-parity): the F8 body-LP shaved ~3dB
//  incidentally with the HF; OUT_TRIM 0.5 -> 0.707 (+3dB) restores peak -16.5 -> -13.5
//  (the Campaign-2 ear-approved level), tone untouched. fingerprint.peak floor back to
//  -15. Cross-drum peak "parity" is a mixer concern, not a kernel one (raw kick2/snare2
//  render hot/unstaged near 0dBFS); clap sits hat2-adjacent, this is self-parity only.
import type { CheckSpec } from '../types';
import { drumBase } from './baselines';

const PERC = ['MOSTLY_SILENT'];
const d = (id: string, title: string, a: CheckSpec['assertion'], params: Record<string, number> = {}, seconds = 1.5): CheckSpec => ({
  id: `clap2.${id}`, engine: 'clap2', title, baseline: drumBase('clap2', params, seconds),
  assertion: a, allowedHealth: PERC,
});

export const clap2Checks: CheckSpec[] = [
  d('fingerprint.peak', 'default clap is audible', { kind: 'absolute', metric: 'peakDb', min: -15, max: 0 }), // floor back to -15: the loudness-parity OUT_TRIM bump (+3dB) restores peak -16.5→-13.5
  d('tone.dir', 'tone brightens the bandpass', { kind: 'directional', param: 'tone', from: 600, to: 2600, metric: 'meanCentroidHz', direction: 'up', minDelta: 300 }),
  d('spread.dir', 'wider spread resolves more distinct slaps (looser train)', { kind: 'directional', param: 'spread', from: 0.006, to: 0.038, metric: 'onsetCount', direction: 'up', minDelta: 1 }, { mix: 0 }), // room off so the detector resolves the slaps
  d('bursts.dir', 'more bursts raise total energy (pure-burst, room off)', { kind: 'directional', param: 'bursts', from: 2, to: 5, metric: 'rmsDb', direction: 'up', minDelta: 1.2 }, { spread: 0.03, mix: 0 }),
  d('body.dir', 'burst body decay audibly changes the envelope', { kind: 'directional', param: 'body', from: 0.003, to: 0.028, metric: 'decaySeconds', direction: 'change', minDelta: 0.05 }, { mix: 0 }), // pure-burst: body sets the per-slap decay
  d('room.dir', 'room lengthens the reverberant tail', { kind: 'directional', param: 'room', from: 0.08, to: 0.7, metric: 'decaySeconds', direction: 'up', minDelta: 1.0 }, { mix: 0.9 }, 3.0), // room-dominant; needs a 3.0s window to resolve the tail
  d('mix.dir', 'mix moves energy from bursts to room tail', { kind: 'directional', param: 'mix', from: 0.1, to: 0.9, metric: 'decaySeconds', direction: 'up', minDelta: 0.05 }),
  d('level.dir', 'level raises output', { kind: 'directional', param: 'level', from: 0.3, to: 0.8, metric: 'peakDb', direction: 'up', minDelta: 4 }),
  d('onset.separation', 'the default clap resolves as >=2 distinct slaps (not one blob)', { kind: 'absolute', metric: 'onsetCount', min: 2 }, { mix: 0 }),
];
