---
name: audio-lab
description: Render Fiddle Synth engines offline and analyze the sound (pitch track, envelope, spectrogram, health) — use before claiming any audible-behavior change works, and to diagnose "why does it sound wrong" reports.
---

# Audio Lab — offline sound verification

Renders the real `*2` kernels (synth2, kick2, hat2, snare2, clap2) in Node and
produces metrics you can read. **It complements, never replaces, the mandatory
browser verification pass** — the browser proves the app wiring; the lab
proves the sound.

## Commands (repo root)

```bash
# Render an engine. Params use the app's wire keys (same as SYNTH2_DESCRIPTORS etc).
npm run lab -- render-engine synth2 --set filter.cutoff=800 \
  --notes "A3:0:0.5,C4:0.6:0.5" --mono --label my-check

# Mod-matrix routes (synth2 only):
npm run lab -- render-engine synth2 --matrix lfo1:filter.cutoff:0.8 --notes "A2:0:1.5"

# Metrics for any WAV; A/B two runs:
npm run lab -- analyze path/to/file.wav
npm run lab -- compare packages/audio-lab/.audio-lab/runs/<A> packages/audio-lab/.audio-lab/runs/<B>
```

Notes syntax `NOTE:START:DUR` (seconds). NOTE is a note name (`A3`, `C#4`, `Eb2`) — raw Hz values are not accepted. `--mono` = monophonic voice
allocation — REQUIRED for portamento/glide checks. Unknown `--set` keys fail
with the full valid-key list — that error IS the param reference.

## Reading a run

Each run directory (printed to stdout; relative paths resolve under `packages/audio-lab/`, so runs land in `packages/audio-lab/.audio-lab/runs/`) contains:

- `report.json` — read `summary` first: `peakDb`, `medianF0`, `f0Range`,
  `onsets`, `attackSeconds`, `decaySeconds`, `meanCentroidHz`,
  `spectralPeaks`, `healthFlags`. Full per-hop arrays follow.
- `waveform.png`, `spectrogram.png` — open with the Read tool (they render as
  images). Spectrogram is log-frequency, bright = loud.
- `pitch.svg`, `envelope.svg` — text SVG; the polyline point coordinates are
  the data if you need to read them precisely.
- `render.wav` — send to the user (SendUserFile) whenever a judgment call is
  contested or aesthetic ("does this sound *good*") rather than measurable.

## Interpretation heuristics

- **Check `healthFlags` first.** `NON_FINITE` = the render is broken; no other metric means anything. `MOSTLY_SILENT` is expected for short percussive one-shots in a longer window (hat2's default decays in ~0.1s) — treat it as broken only for content that should sustain, or when there are no onsets / `peakDb` is very low.
- **Portamento/glide:** render two notes with `--mono`. In `report.json`
  pitch frames, f0 should move smoothly from note 1 to note 2 after the second
  onset. Quantify with `pitchSettleTime` (exported from `@fiddle/audio-lab`)
  or compare `f0Range` across knob settings. No portamento = f0 jumps within
  1-2 frames (~10-20ms); portamento = settle time scales with the knob.
- **Filter cutoff:** `meanCentroidHz` drops as cutoff drops. LFO→cutoff
  wobble shows as periodic centroid movement and visible bands in the
  spectrogram.
- **Envelopes/decay knobs:** `attackSeconds` / `decaySeconds` in the summary;
  the envelope points give the full curve.
- **Tuning:** `medianF0` within ~1Hz for a steady tone. The pitch tracker
  reports null f0 for noisy/unpitched content (hats, claps) — that is
  expected, not a failure; judge those by envelope + spectrum instead.
- **Timing:** `onsets` should match the scheduled note starts within ~10ms.

## Tolerances (never assert exact values)

Kernel noise/S&H PRNGs are seeded per construction by design
(free-running randomness is a feature) — two renders of the same spec are NOT
bit-identical. Compare metrics with tolerances: dB ±1, f0 ±1Hz for steady
tones, times ±10ms. Noise-heavy engines vary more; rely on RMS envelope and
band energy, not sample values.

## Workflow for a DSP change

1. Render a baseline BEFORE the change (`--label before-<feature>`).
2. Make the change; render again (`--label after-<feature>`).
3. `compare` the two run dirs; read the deltas against what the change should do.
4. Also open the after-run's spectrogram/pitch plots — deltas summarize, plots
   catch the unexpected.
5. Report the numbers in your summary to the user, and attach `render.wav`
   when the user should hear it.

## Limits

- Tier 1 covers the five `*2` kernels only; v1 engines and the full project
  mix need the Tier 2 browser harness (Phase 2 — not built yet).
- Renders are mono.
- Long renders are cheap but not free (~a few seconds of CPU per minute of
  audio); keep checks in the 1-5s range.
