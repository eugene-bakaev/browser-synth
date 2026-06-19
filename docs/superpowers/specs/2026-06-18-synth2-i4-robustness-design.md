# synth2 I4 — Robustness Hardening (design)

**Date:** 2026-06-18
**Iteration:** I4 (final planned synth2 iteration; see the parent design
`2026-06-12-worklet-synth-engine-design.md` §12).
**Branch:** `feat/synth2-i4-robustness` (off `main`).

## 1. Goal

Make the synth2 kernel provably safe under garbage input and sustained load.
After I4:

- No NaN/Inf can reach the audio output, regardless of trigger or param input.
- No denormal accumulation in the filter (no CPU spikes on real hardware).
- No per-block allocation in the render path (the spec §10 discipline, now
  enforced by an automated soak test).
- No audible click when the allocator steals an active voice.

I4 adds **no new audible features**. It is correctness, safety, and a
regression net around behaviour the engine already has.

## 2. Scope decisions (settled in brainstorming)

The parent spec's I4 (§12) is a grab-bag of three loosely-coupled efforts. This
iteration takes **only the robustness cluster**. Explicitly deferred (not
dropped):

- **Profiling / WASM-measurement harness.** The parent spec §4 already makes the
  Rust/WASM port a non-goal of *every* iteration ("the port is a separate future
  project triggered by profiling"). §10's "measurement before porting" harness
  produces go/no-go *data* only; its expected verdict is "shelved" (§10's own
  budget math: <0.5 of ~1–3 GFLOPS for realistic 30–60-voice sessions). We are
  not building the harness in I4 — defer until there is a concrete reason to
  suspect a budget problem.
- **Musical polish.** Default-patch tuning, tempo-synced LFO rates,
  free-running LFO mode, stereo voice spread. Each is independent of the
  robustness work and can be its own later slice.

## 3. Why the robustness surface is small

Two existing invariants already do most of the work, and the design leans on
them rather than duplicating them:

- **`ParamSlot.next()` clamps every return to the descriptor `[min, max]`**
  (`ParamSlot.ts:50`). The env/filter/LFO divisor params all have `min ≥ 0.001`
  (`synth2-descriptors.ts`: `env*.a/d/r` min `0.001`, `lfo*.rate` min `0.01`,
  `filter.cutoff` min `20`). So **param values — even under full matrix
  modulation — cannot produce a divide-by-zero or out-of-range NaN.** The
  matrix writes `slot.mod`, and `next()` re-clamps after applying it.
- **Voice gating** (`Synth2Kernel.ts:131`): a voice whose `env1` is idle is
  skipped entirely, and `env1` snaps its level to **exact 0** before idling
  (`LoopEnvelope.ts:99-102`). So the envelope is not a denormal source, and a
  silent voice contributes exact zeros.

What remains is therefore narrow and specific (Units A–D below).

## 4. Unit A — NaN/Inf safety (two layers)

The only NaN ingress that the existing clamps miss is the **note-event
boundary**: `freq`, `velocity`, and `duration` arrive from outside the kernel
(the worklet trigger message) and are clamped with ternary min/max expressions,
which silently pass `NaN` through (`NaN < lo` and `NaN > hi` are both `false`).

Concretely, today:

- `Voice.noteOn` (`Voice.ts:150`) computes
  `this.keyTrackOctaves = Math.log2(freq / KEYTRACK_REF_HZ)`. With `freq ≤ 0` or
  `NaN`, this is `NaN`/`-Inf`, which poisons `octShift` → `fc` → the filter and
  the output.
- The `fc` clamp (`Voice.ts:211`,
  `if (fc < 20) fc = 20; else if (fc > 20000) fc = 20000;`) lets `NaN` through
  unchanged (both comparisons false).
- The velocity clamp (`Voice.ts:149`,
  `velocity < 0 ? 0 : velocity > 1 ? 1 : velocity`) lets `NaN` through, and it
  multiplies the output (`Voice.ts:213`).

In normal play `freq`/`velocity` are always valid, so none of this bites today
— but it is exactly what a fuzz or garbage trigger exposes, and it is a real
unguarded path to production output.

### Layer 1 — root cause (the choke point)

All trigger coercion lands in **one place**, `Synth2Kernel.noteOn`
(`Synth2Kernel.ts:89`):

- `freq`: if not `Number.isFinite(freq)` or `freq <= 0`, **reject the event**
  (return without enqueuing). A meaningless pitch makes no note.
- `velocity`: NaN-safe clamp to `[0, 1]` — test `Number.isFinite(velocity)`
  first (`NaN → 1`, so a garbage velocity still sounds rather than silently
  dropping), then clamp the finite value into `[0, 1]`.
- `duration`: if not finite or `≤ 0`, treat as `0`; the existing
  `Math.max(1, Math.round(d * sampleRate))` then yields a safe 1-frame gate.

**Belt inside `Voice`** (covers tests and any caller invoking `Voice.noteOn`
directly):

- `keyTrackOctaves = (Number.isFinite(freq) && freq > 0) ? Math.log2(freq / KEYTRACK_REF_HZ) : 0`.
- velocity clamp rewritten NaN-safe so any non-finite input becomes a finite
  in-range value. This belt only guarantees finiteness; the kernel choke point
  is the authoritative coercion (`NaN → 1`) and is always reached first in
  production, so the belt's exact NaN target is immaterial — it exists for
  callers (tests) that invoke `Voice.noteOn` directly.
- `fc` clamp rewritten NaN-safe: `fc = fc > 20000 ? 20000 : fc >= 20 ? fc : 20`
  (`NaN` lands on `20`).

> **Implementation note (added post-build).** The fuzz test exposed that
> finite-but-huge `freq` still reaches NaN: the per-oscillator coarse detune
> (±36 st ⇒ ×8) and FM (×5) multiply `freq` into the oscillator's phase
> increment `dt` *downstream* of this boundary, overrunning the single-
> subtraction phase wrap (`|dt| < 1`) → divergence → Inf/NaN. So Layer 1 ships
> with two additions beyond the text above: (a) **cap `freq` to Nyquist**
> (`sampleRate · 0.5`) at both `Synth2Kernel.noteOn` and the Voice belt (the
> belt also substitutes `KEYTRACK_REF_HZ` for a non-finite/≤0 `freq`, not `0`
> octaves); and (b) **clamp `|dt|` to `0.95` in `MorphOscillator.next()`** — the
> one point where `freq · detune · FM` converge — which alone bounds every
> multiplicative path. A further gap was closed: the §3 premise that
> `ParamSlot` makes params NaN-safe was false (the ternary clamp passed `NaN`),
> so `ParamSlot.setBase`/`next` were reordered to the same NaN-safe idiom
> (`x > max ? max : x >= min ? x : min`, `NaN → min`) and the fuzz now also
> injects non-finite param bases.

### Layer 2 — observable production net

In `Synth2Kernel.process`, after the final `renderActive`, sweep `out`:

```
for (let i = 0; i < frames; i++) {
  if (!Number.isFinite(out[i])) { out[i] = 0; this.nonFiniteFlushed++; }
}
```

Cost: one `Number.isFinite` per output sample — 128/block, **independent of
voice count**. `nonFiniteFlushed` is the observability hook (a counter, exposed
via a getter for tests/diagnostics).

### Why the net stays honest (does not mask regressions)

The **fuzz test asserts finiteness at the Voice output, BEFORE the net.** It
drives:

- random param blocks (values both inside and outside `[min, max]`),
- all matrix slots wired to random `src`/`dest`/`amount`,
- random discrete state (osc sync, env loop, filter type, filter model),
- random triggers including `freq ∈ {NaN, 0, -1, 1e9, normal}` and
  `velocity ∈ {NaN, -1, 2, normal}`,
- a seeded RNG for determinism,
- many blocks.

Assertion: every Voice-level output sample is `Number.isFinite`. Because the
assertion is upstream of Layer 2, a future NaN source fails at Layer 1's test
rather than being silently cleaned. A second, separate test asserts
`nonFiniteFlushed === 0` after a normal (valid-input) render.

## 5. Unit B — Denormal sweep (SvfCore)

`SvfCore.ic1eq` / `ic2eq` (`SvfCore.ts:17-18`) are the integrator states. When
the oscillator mix goes silent while `env1` is still active (e.g. a patch with
all osc levels at 0, or FM-gated silence, under sustain), the states decay
toward the subnormal range. V8 has no flush-to-zero, so denormal arithmetic —
~100× slower on some CPUs — does occur.

**Measure first** (systematic-debugging): a test excites the filter with a few
non-zero inputs, then drives `tick(0, cutoff, highResonance)` for many samples
and asserts the integrator states settle to **exact 0**, never lingering in
subnormal range.

**Fix:** threshold flush at the end of `tick`, after the state update
(`SvfCore.ts:48-49`):

```
if (Math.abs(this.ic1eq) < 1e-25) this.ic1eq = 0;
if (Math.abs(this.ic2eq) < 1e-25) this.ic2eq = 0;
```

`1e-25` is far above the subnormal boundary (~2.2e-308) yet inaudible. Cost:
~2 abs + 2 compares/sample. The denormal test reads the states (a test-only
getter or accessor on `SvfCore`) and asserts they reach exact 0.

## 6. Unit C — Zero-alloc soak test

Codifies the parent spec §10 zero-alloc-in-`process()` discipline as an
automated guard. Node with `--expose-gc`:

1. Build a kernel; `applyParams` with a dense block (all matrix slots active).
2. Trigger 8 poly voices; warm up a few blocks.
3. `global.gc()`; record `process.memoryUsage().heapUsed`.
4. Run `N = 10_000` `process()` blocks (128 frames each).
5. `global.gc()`; record `heapUsed`.
6. Assert the heap delta is below a small threshold (effectively zero per
   block; a generous absolute bound absorbs harness noise).

The test **self-skips with a clear message** if `global.gc` is unavailable. It
is wired into the gate via a vitest pool `execArgv: ['--expose-gc']` option and
a `test:soak` npm script so the normal `npm test` exercises it.

## 7. Unit D — Voice-steal audibility

**Measure first:** fill all 8 voices with sustained low notes (smooth output),
then trigger a 9th poly note → the allocator steals the oldest active voice
(`Synth2Kernel.allocate` → `pickVoice`). The stolen voice re-enters via
`LoopEnvelope` `noteOn` with `level > 0`, which takes the 1 ms `steal` ramp to 0
before re-attack (`LoopEnvelope.ts:58-61`, `STEAL_SECONDS = 0.001`).

Render across the steal boundary and assert the output's first-difference shows
**no anomalous spike** relative to the steady-state slope — i.e. the steal ramp
bounds the discontinuity (no click). If the bound fails, tune `STEAL_SECONDS`;
the expectation is it already holds and this unit is a regression lock.

## 8. Testing & verification

- **Gate (must be green before merge):**
  `npm run typecheck && npm test && npm run build` across all three workspaces,
  including the new `--expose-gc` soak; build still emits
  `worklets/synth2-processor.js`.
- **Browser (light, per AGENTS.md):** Playwright MCP smoke — open the dev app,
  play a synth2 patch, twist knobs, confirm the console is clean — then close
  the tab/session. Most of I4 is offline kernel tests; the browser pass is a
  sanity check, not the primary verification.
- Keep the branch after verify — the user browser-verifies before merge
  (don't auto-merge).

## 9. Task slicing (for the implementation plan; ~6 review-sized tasks)

1. Layer-1 trigger coercion + Voice belts (root-cause fixes + unit tests).
2. Layer-2 output net + `nonFiniteFlushed` counter test.
3. Randomized Voice/kernel fuzz test (pre-net finiteness assertion).
4. SvfCore denormal test → threshold flush-to-zero fix.
5. Zero-alloc soak test + `--expose-gc` wiring.
6. Voice-steal discontinuity test (+ tune `STEAL_SECONDS` only if it fails).

Each task ends with an independently testable deliverable and its own green
gate.
```
