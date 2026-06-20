# synth2 Filter Self-Oscillation — Design Spec

**Date:** 2026-06-20
**Status:** Approved (brainstorm complete) — ready for implementation plan
**Scope:** Let synth2's resonance control reach true self-oscillation, so the
filter can sing a sustained tone — usable both as a playable tuned sine and as a
screaming-resonance effect — and add a `filter.drive` saturation control.

## 1. Problem

synth2's filter (`ClassicFilter` / `MorphFilter`, both over the shared Cytomic
zero-delay-feedback `SvfCore`) maps resonance `0..1` to `Q 0.5..10` via
`q = 0.5 + resonance*9.5`, so the damping `k = 1/q` never drops below `0.1`
(`SvfCore.ts:38-40`). The filter therefore rings hard at the top of the knob but
**cannot self-oscillate** — energy always decays. Resonance is also clamped to
`[0,1]` by `ParamSlot`, so modulation can't push past it either.

Self-oscillation needs the damping `k → 0` (Q → ∞): then the resonant poles sit on
the stability boundary and the filter sustains a tone of its own. The `SvfCore`
topology is already the correct one for this — it stays stable at extreme Q under
per-sample cutoff modulation, the reason the engine abandoned the biquad
(`SvfCore.ts` header). What's missing is (a) a resonance map that reaches `k ≈ 0`,
(b) a nonlinearity to pin the oscillation amplitude (a purely linear filter at
`k = 0` has undefined/unbounded amplitude), and (c) a seed so the oscillator starts
from silence when the oscillators are muted.

## 2. Goal

Turning resonance to the top makes the filter self-oscillate, behaving like a real
analog filter at the extreme of its range:

- **Playable tuned sine** — with keytrack at 100% and the oscillators muted, the
  filter sings an in-tune sine that tracks the keyboard (the classic Minimoog
  trick).
- **Screaming-resonance effect** — on a normal patch, the top of the knob howls /
  whistles on whatever is passing through.

A new **`filter.drive`** knob (default 0 = clean = today's sound) dials in feedback
saturation for character, and also shapes the self-oscillation tone. Everything
below the oscillation zone, at `drive = 0`, is **bit-identical to today**.

## 3. Decisions (settled during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Intent | **Full analog** — both a playable tuned sine and a screaming-resonance effect (superset). |
| D2 | Saturation/character | **Separate `drive` knob**, default 0 (clean = today). A minimal limiter pins oscillation amplitude even at `drive = 0`. |
| D3 | Resonance → oscillation map | **Approach A — reserve the top of the knob.** `res ≤ 0.9` is exactly today's `Q` (bit-identical); `res ∈ (0.9, 1.0]` ramps into oscillation. (Approach B kept as a future experiment — §9.) |
| D4 | Tuning | **Reuse existing keytrack.** No new calibration: keytrack 100% already tracks the note 1:1 about C4, and the oscillation frequency is `fc`. Tune the cutoff knob to C4 by ear, like real hardware. |

## 4. Behavior & UX

- The **Res** knob keeps its `0..1` / percent range and 0.15 default. Its *top* now
  reaches oscillation — the plain "just turn it up" mental model. No new toggle, no
  mode.
- **New `Drive` knob** in the filter `knob-row` (next to Res / KeyTrk / EnvAmt),
  `0..1` percent, default 0. At 0 the filter sounds exactly like today; raising it
  adds harmonic grit and a hotter, grittier oscillation.
- **Playing the filter as a tuned sine** is a usage recipe, not new UI: KeyTrk =
  100%, Cutoff ≈ 262 Hz (C4), osc + noise levels at 0, Res to max, Drive to taste.
  The filter then sings an in-tune sine that tracks the keyboard.
- `filter.drive` is a mod **destination** (`modulatable`, `modScale 1`), so an
  LFO/envelope can sweep the saturation/grit.
- **Not built (YAGNI, §10):** a self-oscillation visual indicator on the Res knob;
  a "play the filter" preset/helper; a drive-character readout.

## 5. DSP design

All work happens inside `SvfCore.tick`, whose signature gains one argument:
`tick(input, cutoffHz, resonance, drive)`. `ClassicFilter.process` and
`MorphFilter.process` thread `drive` straight through (their `process` signature
gains a `drive` parameter). The `FilterModule` interface gains `drive` on `process`.
No change to the voice graph, mod matrix, or sync wiring beyond passing the value.

### 5.1 Resonance → `k` map (Approach A — reserve the top)

`resonance` is first clamped to `[0,1]` (defense in depth; `ParamSlot` already
clamps). Then:

```
if (resonance <= 0.9) {
  const q = 0.5 + resonance * 9.5;   // EXACTLY today's formula
  k = 1 / q;                          // res 0 → k=2.0 ... res 0.9 → k≈0.1105
} else {
  const t = (resonance - 0.9) / 0.1;  // 0..1 across the oscillation zone
  k = K09 + t * (K_MIN - K09);        // K09 = 1/9.05 ≈ 0.11050; K_MIN ≈ -0.02
}
```

- For `res ≤ 0.9` the coefficient is **bit-identical** to the current engine, so
  every existing patch in that range is untouched.
- `k` is continuous at the 0.9 join (both sides give `K09`).
- The small **negative** floor `K_MIN` pushes the linear core just past the
  stability boundary so oscillation reliably *starts and grows* from the seed;
  the saturator (§5.2) catches it into a stable limit cycle. `K_MIN` is calibrated
  and locked by the oscillation-amplitude test (§7).

### 5.2 Feedback saturator (`drive` + amplitude limiter, unified)

A soft `tanh` saturator on the band integrator state, governed by a **blend** `B`
(engagement) and a **pre-gain** `D` (hardness):

```
oscZone = resonance <= 0.9 ? 0 : (resonance - 0.9) / 0.1;   // 0..1
B = clamp(drive + oscZone, 0, 1);     // 0 = fully bypassed (bit-linear)
D = 1 + drive * DRIVE_RANGE;          // saturation hardness; drive 0 → D=1

// after the linear SVF update produces the tentative band state `band`:
bandSat = tanh(D * band) / D;         // ≈ band for small signals (no small-signal boost)
band    = band + B * (bandSat - band);// crossfade: B=0 → unchanged (linear)
```

- **`B = 0` ⇒ the saturator is fully bypassed**, so `res ≤ 0.9` *and* `drive = 0`
  is the exact linear `SvfCore` of today (including hot resonant peaks). The
  back-compat lock test (§7) proves this.
- It fades in only as resonance enters the oscillation zone (`oscZone > 0`, to bound
  amplitude) or as `drive` rises (for character across the range).
- `tanh(D*band)/D` keeps small-signal gain ≈ 1, so `drive` adds harmonics at large
  amplitude rather than boosting resonance — the oscillation amplitude stays
  controlled while the timbre gets grittier.
- `DRIVE_RANGE`, the blend shape, and `K_MIN` are **calibrated and locked by tests**
  (§7), the same discipline the noise-color gains used.

The exact integrator the saturator acts on (band state `ic1eq`) and the precise
placement relative to the `2*v - ic` integrator update are an implementation detail
the plan pins down; the invariant is: bypassed at `B = 0`, bounds the limit cycle
otherwise.

### 5.3 Startup excitation (gated noise injection)

A self-oscillator must be seeded: at `k ≤ 0` with exactly-zero state and zero input
(all oscillators muted) the filter stays silent — zero amplified is still zero.
Inside `tick`, **only when `oscZone > 0`**, inject a tiny noise floor into the input,
scaled by `oscZone`:

```
if (oscZone > 0) input += SEED * oscZone * white();   // SEED ≈ 1e-4
```

`white()` is a minimal per-instance xorshift32 (one `uint32` of state, like the
`Noise` kernel), re-seeded to a fixed constant on `reset()` so each note-on is
deterministic. Because the injection is **exactly zero for `resonance ≤ 0.9`**
(`oscZone = 0`), the normal signal path — and every existing exact-silence /
reset-equality test — is bit-unchanged. In the oscillation zone the continuous floor
both *starts* the oscillation from silence and guarantees it *sustains* (far more
robust than a one-shot impulse, and the analog model of thermal noise). It is
allocation-free; `SEED` is calibrated and locked by the startup test (§7).

The chosen seed mechanism deliberately avoids touching integrator state on `reset()`,
which would have broken the `ClassicFilter`/`MorphFilter` "reset == fresh filter"
invariant tests (they compare at 12 decimals).

### 5.4 Tuning

A self-oscillating `SvfCore` sings at its cutoff `fc`. Cutoff is
`fc = cutoffBase * 2^(keyTrack*log2(freq/C4) + envAmount*env2)` (`Voice.ts:216`),
so at **keytrack = 1.0 the cutoff tracks the note exactly 1:1** about C4
(`KEYTRACK_REF_HZ = 261.6256`, `Voice.ts:21,157`). Setting cutoffBase = C4 makes
`fc = freq` → the oscillation is in tune across the keyboard. No calibration system
is added; the tuning test (§7) asserts the oscillation fundamental lands on `fc`.

### 5.5 Invariants preserved

- **Allocation-free**: only scalar state/constants added; no arrays, no per-sample
  `new`.
- **Deterministic**: identical params → identical stream (the per-instance xorshift
  seed is reset to a fixed constant on note-on).
- **Per-voice**: filter state lives on the per-voice `SvfCore` (unchanged).
- **Bounded**: `tanh` bounds all states; the denormal flush, Nyquist clamp, and
  I4 finite-clamp posture are kept.

## 6. Files & back-compat

| File | Change |
|------|--------|
| `packages/client/src/engine/synth2/kernel/SvfCore.ts` | Add `drive` arg to `tick`; new `k` map (§5.1), feedback saturator (§5.2), gated noise-injection startup (§5.3), input NaN-sanitize. Retarget the existing "flushes to exact zero" test (uses `res = 1.0`, which now oscillates) to `res = 0.9`. |
| `packages/client/src/engine/synth2/kernel/FilterModule.ts` | `process` interface signature gains `drive`. |
| `packages/client/src/engine/synth2/kernel/ClassicFilter.ts` | Thread `drive` through `process` into `svf.tick`. |
| `packages/client/src/engine/synth2/kernel/MorphFilter.ts` | Thread `drive` through `process` into `svf.tick`. |
| `packages/client/src/engine/synth2/kernel/Voice.ts` | Add `driveSlot = slot('filter.drive')`; pass `this.driveSlot.next()` into `activeFilter.process(...)`. |
| `packages/shared/src/engines/synth2-descriptors.ts` | **Append** `filter.drive` row (end of table; append-only). |
| `packages/shared/src/engines/synth2.ts` | Add `drive: number` to `Synth2FilterParams` (table↔interface test requires it). Defaults derive from the table. |
| `packages/client/src/components/Synth2Panel.vue` | Add the `Drive` knob to the filter knob-row. |
| Tests | See §7. |

**Descriptor row (appended at the end of `SYNTH2_DESCRIPTORS`):**

```ts
{ key: 'filter.drive', min: 0, max: 1, default: 0, taper: 'linear', modulatable: true, modScale: 1 }
```

Because defaults, the Zod schema (`synth2Modules`), the accept-list, and the
mod-dest list (`MOD_DESTS`) are all **generated from the table**, this single row
propagates everywhere automatically. `modulatable: true` makes it a valid mod
destination.

**Untouched on purpose:** the mod matrix wiring, the voice graph, `normalizeProject`
structure (defaults derive from the table → missing `drive` heals to 0), the sync
accept-list mechanism (numeric leaf, same path as every filter param).

**Back-compat:**
- `filter.drive` missing in an old patch → heals to **0** (no migration).
- **The one genuine behavior change:** a saved patch with `filter.resonance > 0.9`
  now enters the oscillation zone instead of a Q≈10 ping. The default is 0.15 and
  high-resonance settings are uncommon, so the affected set is small — but unlike
  the noise-color reinterpret (masked by `noise.level` defaulting to 0), the filter
  is always in-path, so this is a real, documented change. Accepted under Approach A.

**Known limitation (pre-existing, triggered by this append):** per the slice-level
normalize gap, a new descriptor leaf does not sync into *old* sessions created
before the row existed (new sessions are fine). This recurs on every table append;
the proper fix is deep-merging engine slices in shared `normalize.ts`. **Out of
scope here** (YAGNI) — noted as a known risk, same as prior appends.

## 7. Testing

Gate unchanged: `npm run typecheck && npm test && npm run build` across all
workspaces; build still emits `worklets/synth2-processor.js`.

**`SvfCore.test.ts`:**

1. **Back-compat lock** — frozen golden reference (captured from current behavior)
   for several `(res ≤ 0.9, cutoff, input)` cases at `drive = 0`; the new code
   reproduces them **sample-for-sample**. Proves existing patches are untouched.
2. **`k` map** — `k(res) == 1/(0.5 + res*9.5)` bit-exact for `res ≤ 0.9`; ramps to
   `K_MIN < 0` at `res = 1`; continuous at the 0.9 join.
3. **Oscillation sustains** — `res = 1`, `drive = 0`, zero input, post-reset: over a
   long run RMS stays **above a floor** (doesn't die) and **below a ceiling** (no
   blow-up / no NaN/Inf).
4. **No oscillation at normal res** — `res = 0.5`: a ring excitation decays to ~0
   (today's behavior preserved).
5. **Tuning** — `res = 1`, zero input: the measured fundamental
   (zero-crossings / autocorrelation over a steady window) lands within tolerance
   (≈ ±30 cents) of `fc`, across a few cutoffs (110 / 262 / 440 Hz).
6. **Startup from silence** — zero input throughout: oscillation reaches audible RMS
   promptly (test bound ≤ ~200 ms; validates the gated noise injection).
7. **Drive** — raising `drive` at `res = 1` increases harmonic content (HF metric
   `mean(|x[n]-x[n-1]|)` or a THD proxy) while amplitude stays bounded; `drive > 0`
   differs from `drive = 0`. These tests **calibrate and lock** `DRIVE_RANGE`,
   `K_MIN`, the seed, and the blend shape.
8. **NaN/clamp safety** — NaN input / extreme cutoff at `res = 1` → output stays
   finite (I4 posture).

**Passthrough/integration:** `ClassicFilter.test.ts` / `MorphFilter.test.ts` assert
`drive` reaches `SvfCore` (drive changes output at `res = 1`). A `Voice` / kernel
test confirms muted-osc + `res = 1` + `drive` produces sustained output.

**Contract / params:** the descriptor contract test asserts `filter.drive` is
present with the right shape (`min 0`, `max 1`, `default 0`, `linear`,
`modulatable: true`, `modScale 1`); the table↔interface test
(`synth2.test.ts`) now expects `drive` in `Synth2FilterParams`.

**Sync:** `filter.drive` validates as a `0..1` leaf (rejects out-of-range), is a
valid mod **destination**, and round-trips/converges between clients (mirror the
existing param-sync regression).

**Browser verification (Playwright MCP, then close the session):** add a synth2
track; filter model classic, type LP. Res → max, osc + noise levels → 0,
KeyTrk = 100%, Cutoff ≈ 262 Hz → hear a sustained sine that tracks notes; sweep
Cutoff → pitch follows. Add Drive → grittier, no volume blow-up. Res back to mid →
normal filtering returns. Confirm clean console. (In-tune-by-ear is the user's
sign-off; the test proves `fc` tracking numerically.)

## 8. Out of scope (YAGNI)

- Self-oscillation visual indicator on the Res knob (e.g. glow past 0.9).
- A "play the filter as a sine" preset / helper that sets keytrack + cutoff + osc
  levels in one click.
- A drive-character / waveshape readout.
- The deep-merge `normalize.ts` fix for old-session sync of new descriptor leaves
  (pre-existing gap; tracked separately).

## 9. Future experiment — Approach B (reshape the whole resonance curve)

Kept on record for a later experiment, not built now. Instead of reserving the top
10% of the knob, remap the **entire** `resonance 0..1` range to an exponential `Q`
taper from `0.5` to `∞`, designed so 0.15 still ≈ today's mid-resonance feel but the
run-up to oscillation spreads smoothly across the upper third. Trade-off: smoother,
more musical oscillation control, but every existing patch's resonance is re-voiced
(higher stored values get notably more resonant or oscillate) — a stronger
back-compat shift than Approach A. Worth revisiting once the DSP + drive saturator
from this spec are in place and we can A/B the feel; the curve is the only piece
that would change (the saturator, seed, tuning, and `drive` knob all carry over).

## 10. Rejected alternatives (considered during brainstorming)

- **Saturated-throughout character** (gentle tanh across the whole resonance range
  by default) — rejected in favor of the opt-in `drive` knob (D2) so existing
  patches are unchanged.
- **A separate oscillation region/param** distinct from resonance — rejected as
  control-surface clutter; oscillation lives at the top of the existing Res knob.
