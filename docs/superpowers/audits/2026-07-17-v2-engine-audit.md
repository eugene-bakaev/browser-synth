# First v2 Engine Audit — Findings

Campaign: sub-project A of the audio-audit series (spec
`docs/superpowers/specs/2026-07-17-audio-audit-v2-suite-design.md`).
Suite: `npm run lab:audit` (full) / `npm run lab:audit:fast` (subset).
Branch: `feat/audio-lab-audit`. Audit executed 2026-07-19.

## Run record

| Run | Stamp | Result | Duration |
|---|---|---|---|
| Confirming run 1 | `2026-07-19T07-31-04` | 438/438 PASS | 229s |
| Confirming run 2 | `2026-07-19T07-34-54` | 437/438 — `synth2.matrix.noise->filter.resonance` FAIL (delta 77.9 vs 80) | 230s |
| Flake fix | 30-seed probe: delta min 58 / median 131 / max 198; per-dest `MIN_DELTA_OVERRIDE['filter.resonance'] = { minDepth: 25 }` | — | — |
| Confirming run 3 (post-fix) | `2026-07-19T07-41-25` | 438/438 PASS | 284s |
| Confirming run 4 (post-fix) | `2026-07-19T07-46-09` | 438/438 PASS | 296s |

The one flake was the exact failure mode Task 10 predicted for
noise-sourced cells (Math.random-seeded kernel RNG). The fix also repaired
a latent thin margin: deterministic `lfo2->filter.resonance` measured 85.3
against the old 80 (1.07x); it now has 3.4x. An inert route measures ~0-5,
so 25 keeps the check meaningful.

## Suite inventory (what now exists, permanently)

438 checks: kick2 11, snare2 9, hat2 8, clap2 8, synth2 knobs/enums 51,
synth2 tuning/glide/allocation/fingerprints 15, synth2 mod matrix 336
(8 sources x 42 dests). Full run ~3m50s; fast subset 174 checks ~75s.
Gate-run meta-tests (no renders): matrix exhaustiveness (every current and
future MOD_DEST must be family-classified) and per-engine completeness
(every descriptor key of all five engines must be covered by a check or
declared a blind spot — both stale directions enforced).

**Coverage:** kick2 8/8, snare2 7/7, hat2 6/6, clap2 7/7 keys covered 1:1.
synth2: 70 keys = 52 covered + 18 declared blind spots. Coverage counting
never credits baseline scaffolding — only params a check actually asserts on.

## Declared blind spots (18 — honest statement of what Tier 1 cannot test)

All 18 are `*.sync` / `*.div` params (lfo1/2, env1/2/3 x a/d/r, glide):
tempo-sync is derived on the main thread (effectiveEnvTimes /
effectiveLfoRate / effectiveGlideTime) and the Tier-1 renderer has no BPM,
so these kernel slots are dead offline. Reason code `SYNC_DERIVED` in
`packages/audio-lab/src/audit/checks/blind-spots.ts`. They become testable
in sub-project C (Tier-2 browser harness renders through the real
main-thread path).

## Measured-inert matrix cells (18 in `EXPECTED_INERT`)

Each entry carries a measured number and mechanism in
`packages/audio-lab/src/audit/checks/synth2-matrix.ts`. Groups:
- Self-references: lfo1→lfo1.shape, lfo2→lfo2.shape (plan-anticipated);
  env3→env3.s (sustain default 0 — nothing to modulate).
- Integration cancellation: lfo1/noise→env1.r (fast modulation of a
  duration-integrated metric self-averages to ~0 over the release).
- Noise-source floor: noise→osc1/2/3.level, noise→noise.level,
  noise→lfo1/2.rate (delta spans zero across seeds), noise→filter.keyTrack,
  noise→env2.d, noise→env3.a, lfo2/noise→filter.drive, lfo2→env3.s.
  (osc2/osc3.level inferred by symmetry from the 60-render osc1.level
  measurement — flagged for a direct multi-sample if ever revisited.)

## Engine findings for triage

Ordered by proposed severity. **No engine/DSP code was changed by this
campaign** — every item below is recorded, not fixed.

### F1 — `filter.drive` is totally inert below resonance ≈ 0.9 (proposed: fix-now candidate / backlog)
`SvfCore` applies the drive saturator only inside the self-oscillation zone
(resonance > 0.9). For ~90% of the resonance range the Drive knob does
literally nothing — a silent dead knob in the UI. The audit had to move its
drive checks to resonance 0.95 to see any effect. UX gap: either extend
drive to the normal path, or constrain/annotate the control.

### F2 — Cold-start ParamSlot glide (proposed: backlog)
A freshly-constructed voice's continuous params start at *compiled
descriptor defaults* and converge to the session's actual values only once
the voice renders. First note of a session (or first use of an unused poly
voice slot) audibly glides from defaults for ~5-20ms — measured as a
~0.5-peak transient dominating `peakDb` at low osc levels; also skews
absolute fingerprint peaks. Real, user-audible in edge cases.

### F3 — `osc1.sync` is a permanent no-op by design (proposed: backlog UI decision)
osc1 is always the sync master; `Voice.setSync`'s own comment says the
param is inert. The descriptor row (and hence the panel control) exists and
does nothing, ever. Either hide the control for osc1 or repurpose the row.
Audit check demoted to health-only with a `param` annotation.

### F4 — hat2 `ring` raises peak ~+7.3dB uncompensated (proposed: backlog)
Ring-mod position replaces the 6-member cluster average with a 2-member
product, raising amplitude from -14.9 to -7.6dBFS across the knob. Musically
surprising loudness jump; consider level compensation.

### F5 — Raw-kernel clipping at true defaults (known truth — document, no action)
synth2 default patch (osc levels 0.8+0.8) peaks +7.4dBFS on the raw kernel
(ear-pass render); kick2 default level 0.9 peaks +0.09dBFS. The app's mixer
staging absorbs this; Tier-1 renders the kernel raw. Audit patches use osc
levels ≤0.25; only the true-default fingerprint checks allow `CLIPPING`.

### F6 — Hard-sync DC bias (expected artifact — no action)
osc2/osc3 hard sync of a detuned slave produces ~-0.015 DC (just over the
0.01 flag threshold) from per-cycle waveform asymmetry. Normal for hard
sync; `DC_OFFSET` allowance scoped to exactly those checks.

### F7 — LFO shape morph is non-monotonic in modulation depth (observation)
Centroid mod-depth across shape 0→4 runs 2490 → 2136 → 2472 (dip in the
middle); the 0→4 endpoints nearly cancel. Not a bug (crossfading dissimilar
waveforms), but worth knowing when sound-designing; the audit asserts the
0→2 leg.

### F8 — clap2 voicing (pre-existing BACKLOG — ear-pass question)
Mechanically clap2 passed everything (bursts/spread/body/room/mix all do
what they claim). Whether it *sounds like a clap* is the standing BACKLOG
aesthetic item — the ear-pass WAV is attached for that judgment; nothing
here relitigates it.

## Plan-draft errors the calibration caught (already fixed in the tables)

- snare2 `tone`/`noiseHp` draft metrics moved the WRONG direction
  (per-frame centroid dominated by the wires band; bandLo ratio artifact) —
  swapped to domPeakHz / bandMid with root-cause notes.
- FM routing was backwards in the draft (fm.osc2 means osc1→osc2; the
  draft soloed the modulator instead of the carrier).
- The matrix generator's literal plan pseudocode would have crashed on
  every `dest='none'` cell (no PARAM_INDEX) — route omitted instead
  (identical to the kernel's destEnc=0 "off" encoding).
- kick2 `click`'s draft metric (bandHi) is dead for a 4ms transient —
  only `peakDb` responds; check retitled honestly.
- clap2 `bursts`'s pre-approved fallback (onsetCount) is dead too: the
  kernel's inter-burst gap never drops below the onset-off floor at any
  in-range spread. Swapped to rmsDb (pure-burst patch).

## Lab findings register (the instrument itself)

- **Executor pitchSettle bug (fixed, `87dcae3`):** `pitchSettleTime`
  returns absolute clip time; the executor compared it to elapsed-time
  `knobSeconds`. Every glide check would have been nonsense. Found by
  Task 9, TDD-pinned.
- **Determinism boundary (major methodology correction):** the Tier-1
  renderer is bit-deterministic ONLY while `noise.level = 0` and LFO modes
  stay continuous — `Synth2Kernel` seeds its RNG from `Math.random()` per
  construction (per-session entropy is a product feature). Noise-touching
  checks need seed-aware margins; brown-noise DC_OFFSET flake ~3% is
  scoped on exactly two checks.
- **`summary.pitchSettle.settleSeconds` in report.json is absolute clip
  time**, while the audit executor reports elapsed-since-onset. Same name,
  two meanings — align in a follow-up (report-layer change).
- **Onset detector merges hits over sustained tails:** clap2's default
  room tail keeps the envelope above the onset-off floor — the 4-hit
  ear-pass clip reports `onsets: 1`. Known analyzer characteristic, matters
  when reading multi-hit clips.
- **Pitch-tracker octave-up risk never materialized** — all tuning probes
  (sine + pulse, A2/A3/A4) within 0.008Hz worst-case. No known-issues
  entry needed.
- `known-issues.ts` register: EMPTY after the full campaign — every
  calibration finding was resolved by a better metric, an engineered
  baseline, an EXPECTED_INERT entry, or a threshold with a measured basis.

## Ear-pass renders (true defaults, attached to the triage conversation)

| Engine | peakDb | Character read from spectrogram |
|---|---|---|
| synth2 | +7.4 (CLIPPING — F5) | Three clean harmonic note blocks; audible osc detune beating; no inter-note artifacts |
| kick2 | +0.2 (CLIPPING — F5) | Four identical pitch-drop hits, click transient column at each onset |
| snare2 | -1.2 | Broadband noise + strong tonal shell line (~200Hz); tight repeats |
| hat2 | -14.7 | Six short bright metallic ticks, fast decay, energy centered ~11kHz |
| clap2 | -10.8 | Four broadband bursts with long room tails (tails merge the onset count — see lab register) |

## Triage outcomes

(To be filled after the user conversation: each F-item becomes fix-now /
backlog / known-issue per the user's call.)
