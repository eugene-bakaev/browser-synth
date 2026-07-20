# Audit-Fix Campaign 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the five decided findings from the 2026-07-17 v2-engine audit: pitchSettle report semantics, synth2 cold-start glide blip (F2), synth2 filter.drive dead zone (F1), hat2 ring loudness ride (F4), and osc1.sync closure (F3).

**Architecture:** Three small DSP changes in the client kernels (ParamSlot/Voice, SvfCore, Hat2Kernel), one report-layer fix in packages/audio-lab, one docs-only closure. Each DSP change is TDD'd at the kernel-test level, then A/B'd with the offline audio lab, then its audit checks are recalibrated under the two-clean-runs rule.

**Tech Stack:** TypeScript, vitest, the audio-lab Node renderer (`npm run lab -- render-engine …`), the audit suite (`npm run lab:audit`).

**Spec:** `docs/superpowers/specs/2026-07-19-audit-fixes-design.md` — read it before starting any task.

## Global Constraints

- Branch: `feat/audit-fixes` (already created off main `e66a345`). NEVER commit to main.
- Commit trailer on EVERY commit (both lines):
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01WVnY6qN9VAPu6AHGBHnNfP`
- **Calibration rule** (same as the audit campaign): any changed/new audit-check constant needs two consecutive clean `npm run lab:audit` runs; a directional constant needs |measured delta| ≥ 2 × minDelta; record measured numbers in the commit body.
- The lab renders kernels via direct Node import — **no worklet rebuild needed for lab or vitest work**. Worklet rebuild (`npm run build:worklet -w @fiddle/client`) + full page reload is only needed for the in-browser task (Task 6).
- Lab renders with noise>0 or LFO S&H/Smooth are nondeterministic (RNG seeded from Math.random) — use tolerances; everything else in this plan is deterministic.
- Run all commands from the repo root.
- NEVER `npm run dev` (prod DB). Browser task uses the user's already-running `dev:obs` if present (EADDRINUSE = reuse or ask; never kill it).

---

### Task 1: audio-lab pitchSettle — report elapsed, not absolute

**Files:**
- Modify: `packages/audio-lab/src/report/report.ts:87-93`
- Test: `packages/audio-lab/src/report/report.test.ts`
- Modify: `.claude/skills/audio-lab/SKILL.md` (portamento bullet, ~line 52)

**Interfaces:**
- Produces: `PitchSettleEntry.settleSeconds` becomes elapsed-since-note-onset (was absolute clip time). Field name unchanged; `null` still means "never settled". The audit executor (`src/audit/executor.ts:99-109`) already computes elapsed independently and is NOT touched.

- [ ] **Step 1: Write the failing test** — append to the `report null-safety + new fields` describe block in `report.test.ts`:

```ts
  it('pitchSettle.settleSeconds is elapsed since the note, not absolute clip time', () => {
    // 220Hz for 0.5s, then 440Hz — phase-continuous so pitch tracking is clean.
    const sr = 44100;
    const n = sr; // 1s
    const samples = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const f = i < n / 2 ? 220 : 440;
      ph += (2 * Math.PI * f) / sr;
      samples[i] = 0.5 * Math.sin(ph);
    }
    const r = buildReport({ samples, sampleRate: sr }, { noteTargets: [{ time: 0.5, freq: 440 }] });
    const entry = r.summary.pitchSettle![0];
    expect(entry.settleSeconds).not.toBeNull();
    // The pitch reaches 440 within ~2 analysis hops of t=0.5. Elapsed must be
    // small; the old absolute value would be >= 0.5.
    expect(entry.settleSeconds!).toBeLessThan(0.2);
    expect(entry.settleSeconds!).toBeGreaterThanOrEqual(0);
  });
```

- [ ] **Step 2: Run it, expect FAIL** — `npm -w @fiddle/audio-lab run test -- report` → the new test fails with `settleSeconds` ≈ 0.5+ (absolute).

- [ ] **Step 3: Implement** — in `buildReport` (`report.ts:87-93`) replace the pitchSettle mapping:

```ts
  const pitchSettle: PitchSettleEntry[] | null = opts.noteTargets
    ? opts.noteTargets.map((t) => {
        // pitchSettleTime returns an ABSOLUTE clip time (raw frame.time).
        // Report elapsed-since-note-onset — the field's natural reading and
        // the audit executor's semantics (fix 87dcae3); keeping report.json
        // absolute caused the same misread the executor bug did.
        const abs = pitchSettleTime(pitch.frames, t.time, t.freq);
        return { time: t.time, targetHz: t.freq, settleSeconds: abs === null ? null : abs - t.time };
      })
    : null;
```

(Check `pitchSettleTime`'s return type at `src/analyze/pitch.ts:135` — if it returns `number | null` use `=== null`; adjust to `== null` only if it can return undefined.)

- [ ] **Step 4: Run the package tests, expect PASS** — `npm -w @fiddle/audio-lab run test` (all files; the pre-existing pitchSettle pin test at `report.test.ts:101-109` uses `time: 0` targets, where absolute == elapsed, so it should still pass — if any other test pinned absolute values, update it to elapsed and say so in the commit).

- [ ] **Step 5: Update the skill doc** — in `.claude/skills/audio-lab/SKILL.md`, in the Portamento/glide bullet (~line 52), add one sentence: `` `summary.pitchSettle[].settleSeconds` in report.json is ELAPSED time since that note's onset (not absolute clip time). ``

- [ ] **Step 6: Commit**

```bash
git add packages/audio-lab/src/report/report.ts packages/audio-lab/src/report/report.test.ts .claude/skills/audio-lab/SKILL.md
git commit -m "fix(audio-lab): report pitchSettle as elapsed-since-note, matching executor semantics"
```

---

### Task 2: F2 — synth2 cold-start ParamSlot glide blip

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/ParamSlot.ts`
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts:179-182`
- Test: `packages/client/src/engine/synth2/kernel/ParamSlot.test.ts`, `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

**Interfaces:**
- Produces: `ParamSlot.snap(): void` — jumps the smoother's `current` to `target`. Called by `Voice.noteOn` in its existing cold-voice branch (`if (!this.env1.active)`).

- [ ] **Step 1: Write the failing ParamSlot test** — append inside the `ParamSlot` describe in `ParamSlot.test.ts`:

```ts
  it('snap jumps the smoother straight to its target (cold-voice noteOn)', () => {
    const s = new ParamSlot(lin, SR);
    s.setBase(1);       // far from the 0.5 default
    s.snap();
    expect(s.next()).toBeCloseTo(1, 6); // no 5ms glide from the default
  });
```

- [ ] **Step 2: Write the failing kernel-level test** — append to the `Synth2Kernel` describe in `Synth2Kernel.test.ts`:

```ts
  it('first note of a fresh voice starts at session values, not compiled defaults (F2)', () => {
    const kernel = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['osc1.level']] = 0.1; // far below the 0.8 compiled default
    block[PARAM_INDEX['osc2.level']] = 0;
    block[PARAM_INDEX['osc3.level']] = 0;
    kernel.applyParams(block);
    kernel.noteOn(0, 440, 0.5, 1);
    const out = renderBlocks(kernel, 0, 16); // ~42ms @ 48k
    const peakOf = (from: number, to: number) => {
      let p = 0;
      for (let i = from; i < to; i++) { const a = Math.abs(out[i]); if (a > p) p = a; }
      return p;
    };
    const onsetPeak = peakOf(0, Math.floor(SR * 0.025));
    const steadyPeak = peakOf(Math.floor(SR * 0.025), out.length);
    // Before the fix, osc levels glide 0.8→0.1 over ~5ms and the onset
    // transient dominates (~several× steady). After: same order as steady.
    expect(onsetPeak).toBeLessThan(steadyPeak * 1.5);
  });
```

- [ ] **Step 3: Run both, expect FAIL** — `npm -w @fiddle/client run test -- ParamSlot Synth2Kernel` → snap test fails (`snap` not a function); F2 test fails (onset peak ≫ steady).

- [ ] **Step 4: Implement `ParamSlot.snap`** — add after `setBase` in `ParamSlot.ts`:

```ts
  /** Jump the smoother to its target. Cold-voice noteOn (F2, 2026-07-19): a
   *  freshly-activated voice must START at the session's values, not glide
   *  ~5ms from the compiled defaults — smoothing protects a RUNNING voice
   *  against clicks, it must not smear the first note's onset. */
  snap(): void {
    this.current = this.target;
  }
```

- [ ] **Step 5: Call it from the cold-voice branch** — in `Voice.ts` noteOn, extend the existing block:

```ts
    if (!this.env1.active) {
      this.osc1.reset(); this.osc2.reset(); this.osc3.reset();
      this.activeFilter.reset();
      // F2: snap every param smoother — an inactive voice's slots have been
      // receiving setBase broadcasts but never advancing (renderActive gates
      // on voice.active), so `current` still sits at construction values.
      for (const s of this.slots) s.snap();
    }
```

- [ ] **Step 6: Run the full client kernel tests, expect PASS** — `npm -w @fiddle/client run test`. If any existing test pinned the old cold-start behavior, STOP and re-read it — the fix is spec'd; a conflicting pin most likely encoded the bug (update it and explain in the commit body), but if it encodes something else, escalate.

- [ ] **Step 7: Lab A/B** — with the fix in place:

```bash
npm run lab -- render-engine synth2 --set osc1.level=0.1 --set osc2.level=0 --set osc3.level=0 --notes "A3:0:0.5" --seconds 1 --label f2-after
```

Read the run dir's `report.json` (repo-root path `packages/audio-lab/.audio-lab/runs/<stamp>-f2-after/`): `summary.peakDb` should now reflect the 0.1-level steady tone (≈ −26dB region), NOT a ~0.5-peak (−6dB) onset transient; `attackSeconds` should match env1's default attack, not the 20ms blip. Then `git stash`, render the same spec as `f2-before`, `git stash pop`, and record both peakDb values in the Task-2 commit body.

- [ ] **Step 8: Audit sweep** — `npm run lab:audit`. Expect green: the synth2 fingerprint checks run at default params (no default-vs-session gap → no transient), and `osc*.level.dir` was moved to rmsDb precisely to dodge the old transient. If any check fails, its calibration embedded the transient — recalibrate that constant under the two-clean-runs rule and document the before/after numbers in the commit body. Run `npm run lab:audit` a second time to confirm stability.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/ParamSlot.ts packages/client/src/engine/synth2/kernel/ParamSlot.test.ts packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "fix(synth2): snap param smoothers on cold-voice noteOn — kill first-note glide blip (F2)"
```

(Include any recalibrated audit-check files in the same commit with their numbers in the body.)

---

### Task 3: F1 — filter.drive saturator on the normal path

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/SvfCore.ts` (tick normal path + header comment, lines ~13-22 and ~113-117)
- Test: `packages/client/src/engine/synth2/kernel/SvfCore.test.ts`
- Modify: `packages/audio-lab/src/audit/checks/synth2.checks.ts` (`filter.drive.dir`, lines ~52-56 header + ~244-248)
- Modify: `packages/audio-lab/src/audit/checks/synth2-matrix.ts` (EXPECTED_INERT ~line 151-155, MIN_DELTA_OVERRIDE ~line 201, baselineFor ~line 249-253)
- Check/Modify: `packages/audio-lab/src/audit/checks/synth2-matrix.test.ts` (pins EXPECTED_INERT length 18 → 16)

**Interfaces:**
- Consumes: existing `DRIVE_PRE = 4` and `D = 1 + drive * DRIVE_PRE` (SvfCore.ts:38,160).
- Produces: on the normal path (`oscZone === 0`), `drive > 0` saturates the three outputs; `drive === 0` remains byte-for-byte the original linear filter.

- [ ] **Step 1: Write the failing test** — `SvfCore.test.ts` already has the `refLinearLow` oracle (line ~31) proving res≤0.9 linearity. Add:

```ts
describe('drive on the normal path (F1)', () => {
  it('drive > 0 saturates the normal-path output (was a dead knob)', () => {
    const x = sine(220, 12000);
    const clean = new SvfCore(SR);
    const driven = new SvfCore(SR);
    let diff = 0;
    for (let i = 0; i < x.length; i++) {
      clean.tick(2 * x[i], 800, 0.5, 0);   // hot input so tanh has something to grab
      driven.tick(2 * x[i], 800, 0.5, 1);
      if (i >= 4000) diff += Math.abs(clean.low - driven.low);
    }
    expect(diff).toBeGreaterThan(1); // before the fix: exactly 0.000
  });

  it('drive = 0 stays bit-identical to the linear reference (compat invariant)', () => {
    const x = noiseBuf(8000);
    const svf = new SvfCore(SR);
    const ref = refLinearLow(x, 800, 0.5);
    for (let i = 0; i < x.length; i++) {
      svf.tick(x[i], 800, 0.5, 0);
      expect(svf.low).toBe(ref[i]);
    }
  });
});
```

(If a bit-identical drive-0 test already exists in the file, extend/keep it rather than duplicating — the invariant must be asserted with an explicit `drive = 0` argument either way.)

- [ ] **Step 2: Run, expect one FAIL** — `npm -w @fiddle/client run test -- SvfCore` → saturation test fails (diff = 0); compat test passes.

- [ ] **Step 3: Implement** — in `SvfCore.tick`, immediately after the linear output assignment (lines ~113-117):

```ts
    // Default (linear) outputs — res<=0.9 path is byte-for-byte the original
    // filter; the oscillation-zone block below overwrites them when active.
    this.low = v2;
    this.band = v1;
    this.high = x - k * v1 - v2;

    // F1 (2026-07-19): drive now works on the normal path too — same
    // output-only saturator as the oscillation zone (never fed back into the
    // integrators; state and stability untouched). Gated on drive > 0 so
    // drive-at-0 keeps the bit-identical compat invariant above.
    if (drive > 0 && oscZone <= 0) {
      const D = 1 + drive * DRIVE_PRE;
      this.low = Math.tanh(D * this.low);
      this.band = Math.tanh(D * this.band);
      this.high = Math.tanh(D * this.high);
    }
```

Update the header comment (lines ~19-22) to say drive applies everywhere (output-only tanh), and that the bit-identical invariant is now `resonance <= 0.9 with drive 0`.

- [ ] **Step 4: Run the client tests, expect PASS** — `npm -w @fiddle/client run test`.

- [ ] **Step 5: Lab calibration of the drive curve** — render a normal-resonance patch at drive 0 / 0.5 / 1:

```bash
npm run lab -- render-engine synth2 --set filter.cutoff=800 --set filter.resonance=0.4 --set osc1.level=0.25 --set osc2.level=0.25 --notes "A2:0:1.2" --seconds 1.5 --label f1-drive-0
```

(repeat with `--set filter.drive=0.5` / `=1`, labels `f1-drive-05` / `f1-drive-1`). Compare `meanCentroidHz`, `bandHi`, `peakDb` across the three: drive should add harmonics (centroid/bandHi up) with bounded level change. Judge whether `D = 1 + drive*4` is musically usable at this hotter signal level (listen to the WAVs if borderline). If it's catastrophically harsh, introduce a separate normal-path pre-gain constant (e.g. `DRIVE_PRE_NORMAL = 2`) — a one-line change — and re-render; document the decision + numbers in the commit body either way.

- [ ] **Step 6: Re-baseline the audit drive check** — in `synth2.checks.ts` replace the check at ~line 248 (and rewrite the stale header bullet at ~52-56):

```ts
  c('filter.drive.dir', 'drive saturates and brightens the filter output (normal path)', dir('filter.drive', 0, 1, 'meanCentroidHz', 'up', MINDELTA), { 'filter.cutoff': 800, 'filter.resonance': 0.4, 'osc1.level': 0.25, 'osc2.level': 0.25, 'osc3.level': 0 }),
```

`MINDELTA` = measured delta / 2 (from Step 5's drive-0 vs drive-1 renders), rounded down to a clean number. If centroid moves the wrong way (tanh can DARKEN a bright signal by compressing peaks), switch the metric per what Step 5 measured (bandHi or rmsDb) and retitle honestly — calibration governs, direction claims must match measurement.

- [ ] **Step 7: Un-inert the matrix cells** — in `synth2-matrix.ts`:
  - Delete the two entries `['lfo2', 'filter.drive'], ['noise', 'filter.drive']` and their comment block (lines ~151-155) from `EXPECTED_INERT`.
  - Replace the `filter.drive` engineered baseline in `baselineFor` (~lines 249-253) with a normal-path patch: `if (dest === 'filter.drive') return synth2Held({ 'osc1.level': 0.25, 'osc2.level': 0.25, 'osc3.level': 0, 'filter.cutoff': 800, 'filter.resonance': 0.4 });` (update its comment — the zone-engineering rationale is obsolete).
  - Recalibrate `MIN_DELTA_OVERRIDE['filter.drive']` (~line 201) from fresh measurements: run `npm run lab:audit`, read the drive-dest cell values from the audit report, set minDepth/minScalar so every live source-cell has ≥2× margin (noise gets the worst-seed allowance like `filter.resonance`'s entry). Update the comment with the new numbers.
  - Update `synth2-matrix.test.ts` if it pins the EXPECTED_INERT count (18 → 16) or the drive baseline.

- [ ] **Step 8: Two clean audit runs** — `npm run lab:audit` twice, both 438/438 (the total may change if checks were added elsewhere — both runs must be fully green with stable margins). Record the drive-cell measured values in the commit body.

- [ ] **Step 9: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/SvfCore.ts packages/client/src/engine/synth2/kernel/SvfCore.test.ts packages/audio-lab/src/audit/checks/synth2.checks.ts packages/audio-lab/src/audit/checks/synth2-matrix.ts packages/audio-lab/src/audit/checks/synth2-matrix.test.ts
git commit -m "feat(synth2): filter.drive saturates the normal path — dead-knob fix (F1)"
```

---

### Task 4: F4 — hat2 ring branch level-match

**Files:**
- Modify: `packages/client/src/engine/hat2/kernel/Hat2Kernel.ts` (module consts ~line 19 + mix line ~158)
- Test: `packages/client/src/engine/hat2/kernel/Hat2Kernel.test.ts`
- Modify: `packages/audio-lab/src/audit/checks/hat2.checks.ts`

**Interfaces:**
- Produces: `RING_TRIM` module constant; `cluster = (sum/nClus)*(1-ring) + ringMod*RING_TRIM*ring`.

- [ ] **Step 1: Write the failing test** — `Hat2Kernel.test.ts` has `renderHit(overrides, seconds)`. Append:

```ts
describe('ring level-match (F4)', () => {
  it('ring=1 peaks within ~1.5dB of ring=0 (timbre knob, not a volume ride)', () => {
    const peak = (buf: Float32Array) => {
      let p = 0;
      for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > p) p = a; }
      return p;
    };
    const p0 = peak(renderHit({ ring: 0, decay: 0.3 }, 0.8));
    const p1 = peak(renderHit({ ring: 1, decay: 0.3 }, 0.8));
    const deltaDb = 20 * Math.log10(p1 / p0);
    // measured pre-fix: +7.28dB
    expect(Math.abs(deltaDb)).toBeLessThan(1.5);
  });
});
```

- [ ] **Step 2: Run, expect FAIL** — `npm -w @fiddle/client run test -- Hat2Kernel` → deltaDb ≈ +7.3.

- [ ] **Step 3: Implement** — in `Hat2Kernel.ts` add with the module constants (~line 19):

```ts
// F4 (2026-07-19): level-match the ring-mod branch. A single ±1 product is far
// louder than the 6-square average (measured +7.28dB peak ride ring 0→1);
// RING_TRIM ≈ 10^(-7.28/20) makes `ring` a timbre knob, not a volume ride.
const RING_TRIM = 0.43;
```

and change the mix line (~158):

```ts
      const cluster = (sum / nClus) * (1 - ring) + ringMod * RING_TRIM * ring;
```

- [ ] **Step 4: Run, adjust RING_TRIM if needed, expect PASS** — `npm -w @fiddle/client run test -- Hat2Kernel`. If |deltaDb| ≥ 1.5, nudge RING_TRIM (it's peak-matching a square-ish product against a 6-square average — small deviation is expected); keep the final constant + measured deltaDb in the commit body. Then run the full `npm -w @fiddle/client run test`.

- [ ] **Step 5: Lab A/B** —

```bash
npm run lab -- render-engine hat2 --set ring=0 --set decay=0.3 --notes "A3:0:0.1" --seconds 1.5 --label f4-ring-0
npm run lab -- render-engine hat2 --set ring=1 --set decay=0.3 --notes "A3:0:0.1" --seconds 1.5 --label f4-ring-1
```

Confirm from the two report.json files: peakDb within ~1.5dB of each other, and `meanCentroidHz` still drops substantially at ring=1 (the timbral effect survives the trim — centroid is level-invariant). Record all four numbers in the commit body.

- [ ] **Step 6: Update the audit checks** — in `hat2.checks.ts`:
  - Add the direct regression net after `ring.dir`:

```ts
  d('ring.levelride', 'ring=1 stays level-matched to ring=0 (F4: was a +7.3dB ride)', { kind: 'absolute', metric: 'peakDb', min: LO, max: HI }, { ring: 1, decay: 0.3 }, 1.5),
```

  with `[LO, HI]` = the measured ring=1 peakDb ± 2dB from Step 5 (an absolute window pins the level; a bounded-|delta| assertion kind doesn't exist in the executor — don't invent one).
  - Recalibrate `fingerprint.peak` bounds if the default patch (ring 0.2) shifted its measured peak (currently min −18 vs measured −16.784; the trim lowers the ring contribution slightly — verify, adjust only if margin gets thin).
  - Verify `ring.dir` (centroid down, minDelta 600) still holds with ≥2× margin; recalibrate if the trim changed the mid-sweep centroid path.
  - Update the header comment: the "No CLIPPING… max measured peak −7.585dBFS at ring=1" line is stale after the trim — refresh it with the new measured max.

- [ ] **Step 7: Two clean audit runs** — `npm run lab:audit` twice, fully green (suite count grows by 1 with `ring.levelride`; the completeness meta-test counts assertion targets — confirm it stays green).

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/engine/hat2/kernel/Hat2Kernel.ts packages/client/src/engine/hat2/kernel/Hat2Kernel.test.ts packages/audio-lab/src/audit/checks/hat2.checks.ts
git commit -m "fix(hat2): level-match the ring-mod branch — ring is a timbre knob, not a +7.3dB ride (F4)"
```

---

### Task 5: F3 closure + BACKLOG resolutions

**Files:**
- Modify: `docs/BACKLOG.md` (move 5 entries from `## Open` to `## Resolved`)
- Check only (no change expected): `packages/shared/src/engines/synth2-descriptors.ts:121-124`

**Interfaces:** none (docs only).

- [ ] **Step 1: Verify the F3 facts** — confirm `synth2-descriptors.ts` lines ~121-124 already carry the comment "osc1.sync is inert (osc1 is the sync master) but kept so all 3 oscs share" (it does — no code/descriptor change needed), and `grep -n "osc1.*sync" packages/client/src/components/Synth2Panel.vue` returns nothing (the panel never rendered the control).

- [ ] **Step 2: Move the five entries to Resolved** — in `docs/BACKLOG.md`, move these `## Open` entries (whole blocks) into `## Resolved`, each gaining a resolution line right under its `**Reported:**` line, and change `**Status:** open` to `**Status:** resolved`:
  - "synth2 `filter.drive` is totally inert below resonance ≈ 0.9" → `**Resolved:** 2026-07-19 on feat/audit-fixes (<Task-3 commit sha>) — option (a): saturator extended to the normal path, gated on drive > 0 (drive-at-0 stays bit-identical). Regression net: synth2.filter.drive.dir (normal-path baseline) + live lfo2/noise→filter.drive matrix cells.`
  - "synth2 cold-start ParamSlot glide" → `**Resolved:** 2026-07-19 on feat/audit-fixes (<Task-2 commit sha>) — ParamSlot.snap() on cold-voice noteOn; smoothing now only protects running voices. Net: Synth2Kernel F2 test + osc*.level.dir checks.`
  - "synth2 `osc1.sync` is a permanent no-op but the panel still shows the control" → `**Resolved:** 2026-07-19 — CORRECTION: the panel never rendered a SYNC toggle for osc1 (only osc2/osc3 have one; the claim was inferred from the descriptor row during the kernel-level audit). Descriptor row + its inert-by-design comment stay for wire compat. No code change.`
  - "hat2 `ring` raises output ~+7.3dB uncompensated" → `**Resolved:** 2026-07-19 on feat/audit-fixes (<Task-4 commit sha>) — RING_TRIM level-matches the product branch (measured delta in commit body). Net: hat2.ring.levelride + ring.dir.`
  - "audio-lab: `summary.pitchSettle.settleSeconds` … absolute … two meanings" → `**Resolved:** 2026-07-19 on feat/audit-fixes (<Task-1 commit sha>) — buildReport now reports elapsed-since-note; SKILL.md updated. The onset-detector tail-merging note remains true (informational).`

  Fill each `<commit sha>` from `git log --oneline` — real shas, not placeholders. Keep the original body text of each entry intact below the resolution line (history stays readable).

- [ ] **Step 3: Check the F5 entry's cross-reference** — the F5 entry ("v2 defaults clip the RAW kernels") stays open/informational; re-read it and update its numbers ONLY if Task 2's fix changed the standard measured peaks it cites (it cites default-patch renders, where session==defaults means no transient — expected: no change needed).

- [ ] **Step 4: Commit**

```bash
git add docs/BACKLOG.md
git commit -m "docs(backlog): resolve the five audit-fix entries; correct the F3 osc1.sync UI claim"
```

---

### Task 6: Final verification, ear pass, browser gate

**Files:** none created (verification + renders only).

- [ ] **Step 1: Full gates** — from repo root, all must be green:

```bash
npm test                 # all workspaces
npm run typecheck        # all workspaces
npm run lab:audit        # full suite, run TWICE — both fully green
```

- [ ] **Step 2: Ear-pass renders** — produce and send to the user (SendUserFile) with one line of context each:
  - synth2 drive: the Task-3 `f1-drive-0` / `f1-drive-05` / `f1-drive-1` WAVs (does the new drive sound good, not just measurable?)
  - hat2 ring: the Task-4 `f4-ring-0` / `f4-ring-1` WAVs (timbre change without the loudness jump)
  - synth2 cold start: the Task-2 `f2-after` WAV (clean first-note onset)

- [ ] **Step 3: In-browser verification (MANDATORY — worklet DSP changed in Tasks 2–4):**
  - Rebuild worklets: `npm run build:worklet -w @fiddle/client` (they're built once at dev start, no watch — the running dev server serves stale processors otherwise). Verify the served files' mtime is fresh.
  - Use the user's already-running `dev:obs` if one is up (EADDRINUSE = reuse; NEVER kill it; if none is running, start `npm run dev:obs` yourself — never `npm run dev`).
  - Playwright MCP, full page reload: on a synth2 track play notes with filter.resonance ~0.4 and sweep Drive (audible saturation now); set osc1.level low, reload, play the first note (no blip); on a hat2 track sweep Ring (timbre shift, no loudness jump).
  - Console must be clean; report observations; close the browser tab/session when done.
- [ ] **Step 4: STOP — report to the user.** Summarize the A/B numbers, ear-pass verdicts pending their listen, and await the merge call (final whole-branch review per SDD process precedes this report). Branch stays after merge.
