# clap2 Voicing Re-voice — Design (Campaign 2, audit finding F8)

**Status:** design approved 2026-07-21 · **Branch:** `feat/clap2-voicing` (off `main`)
**Area:** `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts`, `packages/client/src/engine/clap2/worklet-entry.ts`, `packages/shared/src/engines/clap2.ts`, `packages/audio-lab/src/audit/checks/clap2.checks.ts`
**Backlog item:** `docs/BACKLOG.md` → "clap2 voicing — doesn't sound like a convincing hand-clap" (F8)

## Goal

Re-voice clap2 into a **convincing TR-909 drum-machine clap** without rebuilding the
engine — it keeps its burst+room architecture. This is a sound-quality pass, not a
feature: the engine already loads, persists, and every control is mechanically
calibrated (8 audit checks green). The open item is that on ear-test it does not
sound like a real clap.

## Target sound

A **TR-909 drum-machine clap**: a tight burst of distinct slaps decaying in amplitude
into a short, bright room "final slap" — the iconic house/techno backbeat clap, not a
long reverb and not a single dry acoustic hand-clap. This plays to the engine's
existing burst+room DNA.

## Problem — why the current voice falls short

Current model (unchanged since ship): white noise → Chamberlin bandpass at `tone`
(fixed Q 1.2) → gated by an **even, equal-amplitude** train of `bursts` (2–5)
transients spaced by `spread` (0.5 ms attack + `exp(body)` decay), summed with one
`exp(room)` tail, balanced by `mix`. Two facts the 2026-07-19 audit confirmed
mechanically:

1. **The burst train reads as one continuous blob** — the inter-burst gap never dips
   below the onset detector's floor at any in-range `spread`/`body`. The slaps do not
   separate. (Matches the "too uniform" hypothesis.)
2. **The room tail is never fully off** — `roomGain = 0.2 + 0.8·mix` floors at 0.2, so
   even at `mix=0` the tail bleeds in.

Further ear-hypotheses from the backlog: the single fixed-Q bandpass is a thin
spectral model (real claps have a hand-cavity formant plus HF attack content); the
0.5 ms attack is too soft; the "room" reads as reverb rather than a diffuse final slap.

## Approved design decisions

| Decision | Choice |
|---|---|
| Target sound | TR-909 drum-machine clap |
| Scope | Full re-voice — all four levers (burst train, spectrum, room, mix-floor) |
| User knobs | Internal re-voice + changed defaults; **append at most 1–2** knobs only if a lever proves essential |
| Slap pattern | **Randomized per-note scatter** (not a fixed pattern) — hit-to-hit variation |
| Ear loop | I drive to objective audio-lab targets; **user approves the final** in-browser |
| Spectral approach | Broadened single bandpass + HF attack injection (not a two-resonator formant stack) |

## DSP levers

Exact constants (attack ms, scatter percentages, formant frequency, decay slope) are
**ear-tuned during the audio-lab loop** — the spec fixes the mechanism and the
objective target for each lever, not the final numbers.

### (a) Non-uniform + randomized slap pattern — the confirmed defect

Replace the even `j*spread`, equal-amplitude train with:

- A **base non-uniform offset pattern**: tight early slaps widening to the last, that
  `spread` scales (so `spread` remains a meaningful "tightness" control).
- **Decreasing amplitude across slaps** (each slap a fixed fraction of the previous,
  e.g. ~0.8×) so the train reads as a decaying hand-clap, not a flat pulse train.
- A small **per-note random jitter** on each slap's gap and amplitude, from a
  free-running seeded PRNG (see Seeding).
- Coordinated with (b) sharper attack and a faster per-slap decay so the slaps
  **actually separate** in time.

**Objective target:** the audio-lab onset detector resolves **≥2 distinct slaps** at
default params (today: always 1); consecutive per-note renders **differ**; the slap
peak envelope **decreases** across the train.

### (b) Sharper attack

Shorten the per-slap attack from 0.5 ms toward ~0.1–0.2 ms, keeping a tiny anti-click
ramp (no onset discontinuity). Sharper transients both read as "clap" and help the
slaps separate.

**Objective target:** measured attack time drops; onset-region spectral centroid rises.

### (c) Spectral reshape — broadened bandpass + HF attack injection

The single fixed-Q (1.2) bandpass at `tone` is spectrally thin. Approach:

- **Broaden** the main bandpass (lower Q) so it models a hand-cavity formant rather
  than a narrow whistle; `tone` stays its centre.
- Add a fixed **high "presence" resonance / HF injection** on the attack for the bright
  snap real claps have (broadband content in the first ~1 ms of each slap).

Not a two-resonator formant stack (rejected: more coefficients, `tone` mapping less
clean). If ear-testing shows the single-band model can't get there, revisit — but the
starting mechanism is the broadened band + HF injection.

**Objective target:** spectral centroid rises into a clap-like band; spectrum
broadens vs. the current narrow peak (both measurable in audio-lab).

### (d) Room re-voice + drop the mix floor

For a 909 the tail is a short bright final slap, not reverb:

- **Shorten and brighten** the room tail so it reads as the diffuse last slap.
- **Remove the internal `roomGain` 0.2 floor** so `mix=0` is pure slaps. The floor is
  an internal gain mapping, **not** a descriptor range — removing it is wire-safe and
  touches no schema/accept-list/persistence.

**Objective target:** at `mix=0`, room-tail energy ≈ 0; tail decay shorter/brighter
than today; `mix` still moves energy from slaps to tail across its range.

## Seeding — free-running but testable

The randomized scatter makes clap2's **timing** non-deterministic across notes, so it
joins the noise/S&H non-deterministic tier. Mirror the synth2 pattern exactly
(`Synth2Kernel.ts` → `Voice`/`Lfo`):

- `Clap2Kernel` constructor gains an optional `seed` param with a **fixed default**
  (so unit tests and the audit harness are reproducible).
- `worklet-entry.ts` constructs the kernel with **per-session entropy**:
  `(Math.random() * 0x1_0000_0000) >>> 0`, so scatter (and the existing noise texture)
  differ across sessions/reloads.
- The scatter PRNG and the noise PRNG **free-run** across note-ons — never re-seeded on
  trigger — per [[lfo-random-must-free-run]]. Use decorrelated streams (different XOR
  constants off the construction seed) so scatter and noise texture are independent.

## Knob policy

Re-voice through internal DSP + changed **defaults** on the existing 7 knobs
(`tone`, `spread`, `bursts`, `body`, `room`, `mix`, `level`). The descriptor is
**append-only**: changing defaults and widening ranges is safe; **narrowing a range is
forbidden** (breaks already-saved sessions).

Append **at most 1–2** knobs, and only if the audio-lab + ear loop shows a fixed
internal value is too limiting for the 909 target. Candidates, in priority order:

1. `attack` — slap sharpness (lever b).
2. `scatter` or `decay` — the amount of per-note jitter, or the inter-slap amplitude
   decay slope (lever a).

Bar for promoting a constant to a knob: it must be a lever the user would plausibly
want to move for musical variety, not just an internal tuning value. Any append pays
the full checklist: descriptor → `schema.ts` → factory → normalize deep-heal →
`accept-list.ts` → `Clap2Panel.vue` → kernel `params.ts` (block index = array
position). Append at the **end** of `CLAP2_DESCRIPTORS`.

## Objective targets (the ear-loop's measurable proxies)

These are what I drive to in audio-lab before bringing you the candidate. They are
proxies for "convincing 909 clap," not a substitute for your final ear-approval.

- Onset detector resolves **≥2 distinct slaps** at default params (today: 1).
- Consecutive per-note renders **differ** (scatter working); the same seed **reproduces**.
- Slap peak envelope **decreases** across the train.
- Onset/attack **spectral centroid higher** than the body; spectrum broader than the
  current narrow peak.
- At `mix=0`, **room-tail energy ≈ 0**; tail decay shorter than current default.
- **No CLIPPING** on any leg (health check stays green); RMS in a sane range.
- All existing **directional audit checks stay green** (harness re-seeded).

## Test & audit impact

- **Kernel unit tests** (`Clap2Kernel.test.ts`): add the `seed` param; add
  seed-controlled assertions — non-uniform onset spacing, decreasing slap amplitudes,
  per-note variation (two triggers → different output) with same-seed reproducibility,
  and `mix=0` → room-off.
- **Audit checks** (`clap2.checks.ts`): construct the harness kernel with the fixed
  default seed for reproducibility; verify the directional checks
  (`decaySeconds`/`rmsDb`) stay green under the new voice; update the stale inline
  notes ("onsets always 1", the `roomGain` 0.2 floor); likely **add an
  onset-separation check** now that the slaps separate.
- **Worklet is prebuilt, no HMR** ([[worklets-prebuilt-no-hmr]]): browser verification
  requires a worklet rebuild + a full page reload, and confirming the served
  `public/worklets/clap2-processor.js` reflects the change.
- **Descriptor:** defaults may change (safe). **No range narrowing.**

## Verification loop

1. I iterate in audio-lab (`npm run lab -- render-engine …` + the audit checks),
   measuring against the objective targets above and reading spectrograms/envelopes.
2. I land a strong candidate and render WAVs + plots.
3. **You browser-verify** in `dev:obs` (LOCAL Docker DB — never `npm run dev`): a real
   clap2 track, ear-approval, clean console.
4. If it's not there, we iterate on your feedback. I render WAVs for you at any
   checkpoint on request.

## Scope boundaries (YAGNI)

Not touching, and out of scope for this spec:

- The legacy v1 main-thread `clap` engine (untouched).
- Any other drum engine (kick2/snare2/hat2) or the broader drum-voicing polish stage.
- Stereo / multi-channel output (clap2 stays mono, duplicated to channels).
- A preset system.
- A physical-model rebuild — this is a re-voice of the existing burst+room recipe.
- Audit sub-projects B (Tier-2 harness) and C (sequencer/v1/full-mix) — separate work.
