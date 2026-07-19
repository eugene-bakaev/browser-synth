# Audit-Fix Campaign 1 — design

**Date:** 2026-07-19 · **Branch:** `feat/audit-fixes` (off main `e66a345`) · **Status:** approved by user (sections A+B), pending spec review

Fixes the decided findings from the 2026-07-17 v2-engine audit
(`docs/superpowers/audits/2026-07-17-v2-engine-audit.md`, BACKLOG entries dated
2026-07-19). Scope decisions made in brainstorming:

- **In scope (this campaign):** pitchSettle report fix, F2 cold-start glide,
  F1 filter.drive dead zone (option a: extend saturator), F4 hat2 ring
  loudness, F3 osc1.sync (reduced to closure/docs — see Fix 4).
- **Out of scope (Campaign 2, own brainstorm→spec→plan):** F8 clap2 voicing —
  ear-driven sound design, needs listen-and-judge iterations with the user.
- **No action (stay in BACKLOG as informational):** F5 raw-kernel default
  clipping, F6 hard-sync DC, F7 LFO shape non-monotonicity.

## Fix 1 — audio-lab pitchSettle: report elapsed, not absolute

**Problem.** `pitchSettleTime()` returns an absolute clip time. The audit
executor converts to elapsed-since-note-onset (fixed in `87dcae3`), but
`buildReport` (`packages/audio-lab/src/report/report.ts`) still stores the raw
absolute value in `summary.pitchSettle[].settleSeconds` — same conceptual field,
two meanings. Anyone reading a run dir's report.json for glide behavior misreads
it exactly the way the executor bug did.

**Change.** In `buildReport`, subtract the note's `time` when populating
`PitchSettleEntry.settleSeconds` (elapsed semantics, matching the executor and
the field's natural reading). Keep the field name. Null stays null (unsettled).

**Tests/docs.** Update `report.test.ts` pitchSettle pins to elapsed values (they
currently pin absolute behavior). Add one line to
`.claude/skills/audio-lab/SKILL.md`'s portamento section stating settleSeconds
is elapsed-since-note-onset. Close the BACKLOG entry.

**Ordering rationale.** First, so every later glide/A-B reading in this campaign
uses trustworthy report values.

## Fix 2 — F2: synth2 cold-start ParamSlot glide blip

**Problem.** Every `ParamSlot` initializes `current` to the compiled descriptor
default and only advances while its voice renders (`renderActive` gates on
`voice.active`). `applyParams()` broadcasts `setBase` (target) to all voices,
active or not — but `current` never follows until the voice renders. So the
first note on any freshly-constructed voice glides ~5–20ms from compiled
defaults to the session's actual values: an audible onset "blip" when the patch
sits far from defaults (audit measured a ~0.5-peak ~20ms transient dominating
`peakDb` at low target levels).

**Change.**
- `ParamSlot` (`packages/client/src/engine/synth2/kernel/ParamSlot.ts`) gains
  `snap(): void` → `this.current = this.target;`.
- `Voice.noteOn` (`Voice.ts`): in the existing cold-voice branch
  (`if (!this.env1.active) { this.activeFilter.reset(); … }`), also snap every
  slot in `this.slots`.

**Semantics.** Smoothing protects against clicks WITHIN a running voice; a
fresh voice starts at the session's actual values. Mono legato/retrigger on an
active voice keeps smoothing (unchanged). Bit-identical for patches that equal
compiled defaults.

**Tests.** TDD at kernel level: render a cold voice with a param far from
default (e.g. `osc1.level=0.1`), assert no onset transient above the steady
level (before: transient IS the peak). Regression net: existing
`synth2.osc*.level.dir` audit checks (already on rmsDb) plus fingerprint
`peakDb` values — recalibrate any audit constants whose calibration embedded
the transient (Task 9 noted it skews fingerprint peaks).

## Fix 3 — F1: filter.drive saturator on the normal path

**Problem.** `SvfCore.tick` applies the `tanh(D·x)` output saturator only in the
self-oscillation zone (`resonance > 0.9`); on the normal path `drive` is read
but unused — a silent dead knob over ~90% of the resonance range (audit: exact
0.000 delta on all metrics). User decision: option (a) — make drive work
everywhere.

**Change.** In `SvfCore.tick`'s normal path (after the linear `low/band/high`
assignment), when `drive > 0`, run the same output saturator:
`low = tanh(D·low)`, `band = tanh(D·band)`, `high = tanh(D·high)` with the
existing `D = 1 + drive * DRIVE_PRE`. Outputs only, never fed back into the
integrators (matches the osc-zone design; filter state and stability
untouched).

**Compat guarantee preserved.** The gate on `drive > 0` keeps
`resonance ≤ 0.9, drive 0` byte-for-byte identical to the original linear
filter (the file's documented invariant; descriptor default is 0, so untouched
patches are bit-identical). Patches with drive already cranked start actually
saturating — which is what the knob promised. Update the SvfCore header comment
to describe the new invariant precisely.

**Calibration question (lab answers it).** The osc zone runs at a controlled
target level; the normal path can carry hotter signal (raw kernels at full osc
levels), so `D = 1 + drive·4` may be too aggressive there. The lab A/B decides
whether the shared DRIVE_PRE stands or the normal path needs its own mapping;
either outcome is documented in the commit body with measured harmonics/centroid
deltas. Audible-taste check via ear-pass WAVs.

**Audit updates.** `synth2.filter.drive.dir` recalibrates to a normal-path
baseline (it currently hides at res 0.95 with near-zero osc levels specifically
because of this bug — retitle/re-baseline to a normal-resonance patch). Remove
`lfo2→filter.drive` and `noise→filter.drive` from `EXPECTED_INERT` in
`synth2-matrix.ts` — those matrix cells go live and must pass (calibrate
`MIN_DELTA_OVERRIDE['filter.drive']` as needed). The completeness meta-tests
enforce the reclassification.

## Fix 4 — F4: hat2 ring branch level-match

**Problem.** `Hat2Kernel` line ~158 crossfades the 6-square cluster AVERAGE
(sum/6) toward the raw 2-square ring-mod PRODUCT (±1); the product branch is
inherently much louder, so peak rises monotonically −14.86 → −7.59dBFS
(Δ+7.28dB) across a knob whose job is timbre — turning it up mostly reads as
"louder".

**Change.** Scale the product term: `ringMod * RING_TRIM * ring` (named
constant with a comment citing the measured Δ). Start at
`RING_TRIM ≈ 0.43` (=10^(−7.28/20)); calibrate in the lab so peak at ring=1
matches ring=0 within ~1dB across representative patches. Existing patches
with ring>0 get quieter — intended.

**Audit updates.** `hat2.ring.dir` (centroid down) is the timbre net —
unchanged in intent, recalibrate constants if needed. `hat2.fingerprint.*`
bounds recalibrate if the default patch's measured peak shifts (peak bound was
calibrated at −18..0 with current levels). Add a new `hat2.ring.levelride`
check asserting |peakDb(ring=1) − peakDb(ring=0)| stays within a calibrated
bound (~1–2dB) — the direct regression net for this fix.

## Fix 5 — F3: osc1.sync — closure and docs only

**Discovery during brainstorming (corrects the BACKLOG entry).** The panel
does NOT render a SYNC toggle for osc1 — `Synth2Panel.vue` only renders sync
buttons for osc2/osc3. The BACKLOG claim was inferred from the descriptor row
during the kernel-level audit and is wrong at the UI layer. The user's "hide
it" decision is already satisfied by reality.

**Change.** No app code. Annotate the `osc1.sync` descriptor row comment in
`packages/shared/src/engines/synth2-descriptors.ts` (inert by design — osc1 is
the sync master; row retained for wire compat). Move the BACKLOG entry to
Resolved with the correction note.

## Execution process

- One branch `feat/audit-fixes` off main `e66a345`; task-per-fix in order:
  **Fix 1 (pitchSettle) → Fix 2 (F2) → Fix 3 (F1) → Fix 4 (F4) → Fix 5
  (F3 closure + BACKLOG resolutions)**. Fix 2 precedes 3/4 because its onset
  transient pollutes peak measurements — later A/Bs get cleaner.
- Subagent-driven execution (same machinery as the audit campaign): fresh
  implementer per task, per-task review, durable ledger.
- Every DSP task ships with: TDD tests where Node-testable, lab A/B
  (`npm run lab -- render-engine`, before/after metric deltas in the commit
  body), audit-check recalibration under the two-clean-runs rule, ear-pass
  WAVs sent to the user.
- Exit gates: `npm run lab:audit` green twice consecutively; root `npm test`
  green; typecheck clean; opus whole-branch review; mandatory in-browser pass
  (Fixes 2–4 change client worklet DSP → worklet rebuild + full page reload,
  Playwright, clean console, report observations); merge on user call; branch
  kept after merge.
- BACKLOG: entries for pitchSettle, F1, F2, F3, F4 move to Resolved with
  commit references; F5's note is updated if Fix 2 changes standard measured
  peaks.

## Non-goals

- No clap2 voicing work (Campaign 2).
- No change to `pitchSettleTime()` analyzer itself (report layer only).
- No DC blocker on the sync path (F6 stays informational; its scoped
  `DC_OFFSET` allowances stay).
- No kernel self-staging / headroom trim (F5 decision deferred).
- No descriptor removals — `osc1.sync` row stays for wire compat.
