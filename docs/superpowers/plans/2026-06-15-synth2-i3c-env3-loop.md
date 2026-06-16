# synth2 I3c — env3 + loop mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a third per-voice envelope (`env3`, a matrix-source-only ADSR) and a `loop` toggle on all three envelopes that cycles attack→decay→attack while a note is held.

**Architecture:** Append 7 descriptor rows (`env3.a/d/s/r` continuous + `env1/2/3.loop` as `kind:'bool'`) to the single-source-of-truth table, so schema/accept-list/defaults/param-block/MOD_DESTS all derive automatically. Add the loop branch to `LoopEnvelope`, wire `env3` into `Voice` (mirroring the I3b LFO previous-sample source pattern), decode the loop bools at the block boundary in `Synth2Kernel` (mirroring `setSync`), and surface LOOP buttons + an ENV 3 panel column.

**Tech Stack:** TypeScript, Vue 3, Vite, Web Audio AudioWorklet, Zod, Vitest, npm workspaces (`@fiddle/shared`, `@fiddle/client`).

**Design doc:** `docs/superpowers/specs/2026-06-15-synth2-i3c-env3-loop-design.md`

**Append-only ABI:** `SYNTH2_DESCRIPTORS` is append-only after merge — the array index IS the Float32Array param-block index and wire ABI. Every new row goes at the **tail**, after `lfo2.shape`. Never insert or reorder.

**Gate (run after each task):** `npm run typecheck && npm test` from the repo root; full gate (`+ npm run build`) before the final review.

---

### Task 1: Shared — descriptor table (+7 rows) + descriptor tests

**Files:**
- Modify: `packages/shared/src/engines/synth2-descriptors.ts`
- Test: `packages/shared/src/engines/synth2-descriptors.test.ts`

- [ ] **Step 1: Update the failing contract tests first (snapshot + discrete set + tail)**

In `packages/shared/src/engines/synth2-descriptors.test.ts`:

(a) Add the three loop keys to `DISCRETE_KEYS` (line ~9):
```ts
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'env1.loop', 'env2.loop', 'env3.loop'];
```

(b) Rename the full-key snapshot test to I3c and append the 7 new keys (the `it('covers exactly the I3b param set …')` block, lines ~26–39):
```ts
  it('covers exactly the I3c param set (append-only from here)', () => {
    expect(SYNTH2_DESCRIPTORS.map(d => d.key)).toEqual([
      'osc1.morph', 'osc1.pulseWidth', 'osc1.coarse', 'osc1.fine', 'osc1.level',
      'env1.a', 'env1.d', 'env1.s', 'env1.r',
      'osc2.morph', 'osc2.pulseWidth', 'osc2.coarse', 'osc2.fine', 'osc2.level',
      'osc3.morph', 'osc3.pulseWidth', 'osc3.coarse', 'osc3.fine', 'osc3.level',
      'noise.level', 'noise.color',
      'fm.osc2', 'fm.osc3',
      'osc1.sync', 'osc2.sync', 'osc3.sync',
      'env2.a', 'env2.d', 'env2.s', 'env2.r',
      'filter.cutoff', 'filter.resonance', 'filter.keyTrack', 'filter.envAmount', 'filter.type',
      'lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape',
      'env3.a', 'env3.d', 'env3.s', 'env3.r',
      'env1.loop', 'env2.loop', 'env3.loop',
    ]);
  });
```

(c) The I3b test `it('appends exactly four LFO rows at the tail (append-only)', …)` (line ~126) is no longer "at the tail". Replace its body so it locates the LFO rows positionally instead of from the end:
```ts
  it('keeps the four LFO rows consecutive in table order (I3b)', () => {
    const i = SYNTH2_DESCRIPTORS.findIndex(d => d.key === 'lfo1.rate');
    expect(SYNTH2_DESCRIPTORS.slice(i, i + 4).map(d => d.key))
      .toEqual(['lfo1.rate', 'lfo1.shape', 'lfo2.rate', 'lfo2.shape']);
  });
```

(d) Append a new I3c describe block at the end of the file:
```ts
describe('env3 + loop descriptor rows (I3c)', () => {
  const byKey = Object.fromEntries(SYNTH2_DESCRIPTORS.map(d => [d.key, d]));

  it('appends the seven I3c rows at the tail (append-only)', () => {
    const tail = SYNTH2_DESCRIPTORS.slice(-7).map(d => d.key);
    expect(tail).toEqual([
      'env3.a', 'env3.d', 'env3.s', 'env3.r', 'env1.loop', 'env2.loop', 'env3.loop',
    ]);
  });

  it('env3 a/d/s/r mirror env1/env2 (continuous, modulatable, expOctaves times)', () => {
    expect(byKey['env3.a']).toMatchObject({ min: 0.001, max: 10, default: 0.2, taper: 'expOctaves', modulatable: true, modScale: 4 });
    expect(byKey['env3.d']).toMatchObject({ default: 0.3, taper: 'expOctaves', modulatable: true });
    expect(byKey['env3.s']).toMatchObject({ min: 0, max: 1, default: 0, taper: 'linear', modulatable: true, modScale: 1 });
    expect(byKey['env3.r']).toMatchObject({ default: 0.3, taper: 'expOctaves', modulatable: true });
    for (const k of ['env3.a', 'env3.d', 'env3.s', 'env3.r']) {
      expect(byKey[k].kind, k).toBeUndefined(); // continuous
    }
  });

  it('loop rows are discrete booleans, default off, excluded from the mod matrix', () => {
    for (const k of ['env1.loop', 'env2.loop', 'env3.loop']) {
      const d = byKey[k];
      expect(d.kind, k).toBe('bool');
      expect(isDiscrete(d), k).toBe(true);
      expect(d.modulatable, k).toBe(false);
      expect(d.default, k).toBe(0); // false
    }
  });

  it('MOD_SOURCES is unchanged (env3 was always present; now live)', () => {
    expect(MOD_SOURCES).toEqual(['none', 'lfo1', 'lfo2', 'env1', 'env2', 'env3', 'velocity', 'noise']);
  });

  it('MOD_DESTS gains the four env3 keys but NOT the loop bools', () => {
    for (const k of ['env3.a', 'env3.d', 'env3.s', 'env3.r']) expect(MOD_DESTS).toContain(k);
    for (const k of ['env1.loop', 'env2.loop', 'env3.loop']) expect(MOD_DESTS).not.toContain(k);
  });
});
```
Confirm `isDiscrete` is in the existing import from `./synth2-descriptors.js` at the top of the test (it is).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: FAIL — snapshot mismatch (missing 7 keys), `DISCRETE_KEYS` mismatch, and the new I3c block referencing keys that don't exist yet.

- [ ] **Step 3: Append the seven descriptor rows + de-stale the MOD_SOURCES comment**

In `packages/shared/src/engines/synth2-descriptors.ts`, append immediately after the `lfo2.shape` row (the current last row, line ~125), before the closing `];`:
```ts
  // --- I3c env3 + loop mode (append-only). env3 mirrors env1/env2 (a/d/r
  // expOctaves time taper, s linear) but is NOT hardwired to anything — it
  // exists solely as the env3 mod source (live as of I3c). The three loop rows
  // mirror the sync toggles: kind:'bool', applied at the block boundary, NOT
  // mod-matrix destinations (modulatable:false). Default off ⇒ behavior unchanged.
  { key: 'env3.a',    min: 0.001, max: 10, default: 0.2, taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'env3.d',    min: 0.001, max: 10, default: 0.3, taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'env3.s',    min: 0,     max: 1,  default: 0,   taper: 'linear',     modulatable: true,  modScale: 1 },
  { key: 'env3.r',    min: 0.001, max: 10, default: 0.3, taper: 'expOctaves', modulatable: true,  modScale: 4 },
  { key: 'env1.loop', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env2.loop', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env3.loop', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
```

Then update the `MOD_SOURCES` comment (lines ~137–138) — `env3` is no longer inert:
```ts
// Source enum: ORDER IS THE WIRE ENCODING for matrix[*].source and the index
// into the kernel's per-sample sources[] array. Append-only. lfo1/lfo2 went
// live in I3b; env3 went live in I3c. All listed sources now produce real values.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @fiddle/shared -- synth2-descriptors`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts
git commit -m "feat(shared): append env3 + loop descriptor rows (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Shared — params interface + defaults

**Files:**
- Modify: `packages/shared/src/engines/synth2.ts`
- Test: `packages/shared/src/engines/synth2.test.ts`

- [ ] **Step 1: Update / add the failing defaults tests**

In `packages/shared/src/engines/synth2.test.ts`:

(a) The existing env2 equality test (line ~46) must include the new `loop` leaf — update it:
```ts
  it('defaults env2 to the same a/d/s/r as env1, loop off', () => {
    expect(DEFAULT_SYNTH2_PARAMS.env2).toEqual({ a: 0.01, d: 0.2, s: 0.5, r: 0.5, loop: false });
  });
```

(b) Add an env3 + loop defaults test after the LFO defaults test (line ~60):
```ts
  it('defaults env3 to a 0.2 / d 0.3 / s 0 / r 0.3, loop off (I3c)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.env3).toEqual({ a: 0.2, d: 0.3, s: 0, r: 0.3, loop: false });
  });

  it('defaults env1.loop and env2.loop to false (boolean, not number) (I3c)', () => {
    expect(DEFAULT_SYNTH2_PARAMS.env1.loop).toBe(false);
    expect(DEFAULT_SYNTH2_PARAMS.env2.loop).toBe(false);
    expect(typeof DEFAULT_SYNTH2_PARAMS.env3.loop).toBe('boolean');
  });
```

- [ ] **Step 2: Run typecheck to verify it fails**

Run: `npm run typecheck -w @fiddle/shared`
Expected: FAIL — `DEFAULT_SYNTH2_PARAMS.env3` does not exist on `Synth2EngineParams`, and `loop` is not on `Synth2EnvParams`. (The defaults are runtime-generated from the table, so the *test runner* would pass at runtime once Task 1 landed; the typecheck is what surfaces the missing interface fields.)

- [ ] **Step 3: Add the interface fields**

In `packages/shared/src/engines/synth2.ts`:

(a) Add `loop` to `Synth2EnvParams` (lines ~20–25):
```ts
export interface Synth2EnvParams {
  a: number;
  d: number;
  s: number;
  r: number;
  loop: boolean; // I3c: cycle attack→decay→attack while gated (shared by env1/env2/env3)
}
```

(b) Add `env3` to `Synth2EngineParams`, beside `env1`/`env2` (lines ~64–65):
```ts
  env1: Synth2EnvParams;
  env2: Synth2EnvParams;
  env3: Synth2EnvParams; // I3c: third envelope — matrix source only, not hardwired
  filter: Synth2FilterParams;
```

`buildDefaults()` is unchanged — it groups descriptor rows by module prefix and decodes `kind:'bool'` via `decodeBool`, so `env3.{a,d,s,r}` and `{env1,env2,env3}.loop` populate from the rows added in Task 1.

- [ ] **Step 4: Run typecheck + tests to verify they pass**

Run: `npm run typecheck -w @fiddle/shared && npm test -w @fiddle/shared -- synth2.test`
Expected: PASS (including the `mirrors the descriptor table exactly` leaf-count test, which auto-adapts to 46).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): env3 + loop on Synth2EngineParams (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Shared — schema + accept-list derivation locks (no production change)

**Files:**
- Test: `packages/shared/src/project/schema.test.ts`
- Test: `packages/shared/src/project/accept-list.test.ts`

Both `schema.ts` and `accept-list.ts` are fully descriptor-derived for synth2 (see spec §3). No production edits — these tests lock the derivation so a future hand-edit can't drift.

- [ ] **Step 1: Add the failing/locking tests**

In `schema.test.ts`, add (inside the synth2 describe block, mirroring existing leaf-validation tests):
```ts
  it('accepts an env3 ADSR + loop and the env1/env2 loop booleans (I3c)', () => {
    const base = structuredClone(DEFAULT_SYNTH2_PARAMS);
    base.env3 = { a: 1, d: 2, s: 0.3, r: 1.5, loop: true };
    base.env1.loop = true;
    base.env2.loop = false;
    expect(() => Synth2ParamsSchema.parse(base)).not.toThrow();
  });

  it('rejects a non-boolean env loop and an out-of-range env3 time (I3c)', () => {
    const bad1 = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    bad1.env1.loop = 1; // number, not boolean
    expect(() => Synth2ParamsSchema.parse(bad1)).toThrow();
    const bad2 = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    bad2.env3.a = 999; // > max 10
    expect(() => Synth2ParamsSchema.parse(bad2)).toThrow();
  });
```
Ensure `Synth2ParamsSchema` and `DEFAULT_SYNTH2_PARAMS` are imported in this test (mirror the existing imports at the top of the file; `DEFAULT_SYNTH2_PARAMS` comes from `@fiddle/shared` or the engines module — match whatever the surrounding synth2 tests use).

In `accept-list.test.ts`, add inside the `describe('synth2 accept-list (generated from descriptors)', …)` block. The helpers are `pathIsWritable(dotPath)` and `validatePathAndValue(dotPath, value)` (dot-string paths). Note: the existing generated test (which iterates `SYNTH2_DESCRIPTORS`) already covers these new leaves automatically — this is an explicit, readable lock:
```ts
  it('accepts synth2 env3 leaves and the env loop booleans (I3c)', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.env3.a')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.env3.a', 1.5)).toEqual({ ok: true });
    expect(pathIsWritable('tracks.0.engines.synth2.env3.loop')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.env1.loop', true)).toEqual({ ok: true });
    // a number at a loop (bool) leaf is rejected (spec §6.6 — booleans on the wire)
    expect(validatePathAndValue('tracks.0.engines.synth2.env2.loop', 1).ok).toBe(false);
  });
```
`pathIsWritable` and `validatePathAndValue` are already imported at the top of the file.

- [ ] **Step 2: Run the tests**

Run: `npm test -w @fiddle/shared -- schema accept-list`
Expected: PASS on the first run (derivation already covers the new leaves). If any fail, the schema/accept-list derivation has a gap — fix the derivation (not the test) and note it.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/project/schema.test.ts packages/shared/src/project/accept-list.test.ts
git commit -m "test(shared): lock env3 + loop schema/accept-list derivation (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Client kernel — LoopEnvelope loop mode

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/LoopEnvelope.ts`
- Test: `packages/client/src/engine/synth2/kernel/LoopEnvelope.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/engine/synth2/kernel/LoopEnvelope.test.ts` (the helpers `makeEnv`, `run`, `SR` already exist at the top of the file):
```ts
describe('LoopEnvelope loop mode (I3c)', () => {
  it('loop off (default): settles and holds at sustain — plain ADSR, unchanged', () => {
    const env = makeEnv(0.005, 0.01, 0.5, 0.05);
    env.noteOn(SR);
    run(env, Math.round(SR * 0.1));
    expect(env.level).toBeCloseTo(0.5, 2); // resting at sustain, not cycling
  });

  it('loop on: cycles while gated — level both falls to the floor and climbs back', () => {
    const env = makeEnv(0.005, 0.01, 0, 0.05); // s=0 → full-depth ramp
    env.setLoop(true);
    env.noteOn(SR); // long gate
    const buf = run(env, Math.round(SR * 0.1)); // 100ms = many AD cycles
    expect(Math.min(...buf)).toBeLessThan(0.1);    // reaches the floor
    expect(Math.max(...buf)).toBeGreaterThan(0.9); // climbs back to peak
    let crossings = 0;
    for (let i = 1; i < buf.length; i++) if (buf[i - 1] < 0.5 && buf[i] >= 0.5) crossings++;
    expect(crossings).toBeGreaterThan(2); // multiple cycles in 100ms
  });

  it('sustain level sets the loop floor: lower s swings deeper', () => {
    const deep = makeEnv(0.005, 0.01, 0.0, 0.05); deep.setLoop(true); deep.noteOn(SR);
    const shallow = makeEnv(0.005, 0.01, 0.7, 0.05); shallow.setLoop(true); shallow.noteOn(SR);
    const dBuf = run(deep, Math.round(SR * 0.1));
    const sBuf = run(shallow, Math.round(SR * 0.1));
    expect(Math.min(...dBuf)).toBeLessThan(Math.min(...sBuf));
  });

  it('gate-off from a looping envelope enters release and reaches 0', () => {
    const env = makeEnv(0.005, 0.01, 0, 0.02);
    env.setLoop(true);
    env.noteOn(Math.round(SR * 0.05)); // 50ms gate
    run(env, Math.round(SR * 0.05));   // gate elapses mid-cycle
    run(env, Math.round(SR * 0.03));   // > r past release
    expect(env.level).toBe(0);
    expect(env.active).toBe(false);
  });

  it('toggling loop on while resting in sustain resumes cycling (live-toggle responsive)', () => {
    const env = makeEnv(0.005, 0.01, 0.5, 0.05);
    env.noteOn(SR);
    run(env, Math.round(SR * 0.05)); // reach + hold sustain with loop off
    expect(env.level).toBeCloseTo(0.5, 2);
    env.setLoop(true);
    const buf = run(env, Math.round(SR * 0.05));
    expect(Math.max(...buf)).toBeGreaterThan(0.9); // climbs back to peak again
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- LoopEnvelope`
Expected: FAIL — `env.setLoop is not a function`, and the looping cases never cycle.

- [ ] **Step 3: Implement loop mode**

In `packages/client/src/engine/synth2/kernel/LoopEnvelope.ts`:

(a) Add the field beside `private stage` (line ~29):
```ts
  private stage: Stage = 'idle';
  private loop = false;
```

(b) Add the setter (after the constructor, before `get active`):
```ts
  /** Block-boundary discrete toggle (spec §5.4). loop mode cycles attack→decay
   *  →attack while the gate is held. No smoother — latched until the next param
   *  update, exactly like the osc sync / filter type discrete params. */
  setLoop(loop: boolean): void {
    this.loop = loop;
  }
```

(c) In `next()`, change the `sustain` case so loop re-enters attack (responsive to a live toggle):
```ts
      case 'sustain':
        if (this.loop) {
          this.stage = 'attack'; // loop: no resting stage — climb again from here
        } else {
          this.level = this.s.next();
        }
        break;
```

(d) In `next()`, change the `decay` case end so loop re-enters attack instead of resting in sustain:
```ts
      case 'decay': {
        const sus = this.s.next();
        this.level -= (this.dt * (1 - sus)) / this.d.next();
        if (this.level <= sus) {
          this.level = sus;
          this.stage = this.loop ? 'attack' : 'sustain';
        }
        break;
      }
```

The attack/release/steal/idle cases and the gate countdown are unchanged: gate-off still forces `release` from the current level regardless of stage, so a looping envelope releases correctly on note-off. The re-attack ramps from the held level (`sus`) up to 1 with no discontinuity (no steal ramp needed mid-cycle).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- LoopEnvelope`
Expected: PASS (all I1 ADSR tests + the new I3c loop tests).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/LoopEnvelope.ts packages/client/src/engine/synth2/kernel/LoopEnvelope.test.ts
git commit -m "feat(client): LoopEnvelope loop mode (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Client kernel — Voice env3 wiring + setEnvLoop

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Voice.ts`
- Test: `packages/client/src/engine/synth2/kernel/Voice.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `packages/client/src/engine/synth2/kernel/Voice.test.ts`:
```ts
describe('Voice env3 source + loop (I3c)', () => {
  const SR = 48000;

  it('routes env3 → osc1.level so the third envelope modulates output (no longer inert)', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const env3Src = MOD_SOURCES.indexOf('env3');
    const render = (route: boolean) => {
      const v = new Voice(SR, 1);
      if (route) v.setMatrixSlot(0, env3Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(4096);
      v.renderAdd(out, 0, 4096);
      return out;
    };
    const base = render(false), routed = render(true);
    let maxDiff = 0;
    for (let i = 0; i < base.length; i++) maxDiff = Math.max(maxDiff, Math.abs(base[i] - routed[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });

  it('noteOn resets env3Prev so a reused voice has no env3 bleed on the first sample', () => {
    const env3Src = MOD_SOURCES.indexOf('env3');
    const levelIdx = PARAM_INDEX['osc1.level'];
    const gate = 11000; // long enough that env3 (a 0.2 / d 0.3) is mid-contour at retrigger

    const a = new Voice(SR, 1); // warmed-up + retriggered → exercises the reset
    const b = new Voice(SR, 1); // fresh reference
    a.noteOn(220, 1.0, gate); b.noteOn(220, 1.0, gate);
    const buf = new Float32Array(gate);
    a.renderAdd(buf, 0, gate);
    b.renderAdd(buf.fill(0), 0, gate);

    a.setMatrixSlot(0, env3Src, levelIdx, 1); // route on A only, after warmup
    a.noteOn(220, 1.0, SR); b.noteOn(220, 1.0, SR);

    const outA = new Float32Array(1); const outB = new Float32Array(1);
    a.renderAdd(outA, 0, 1); b.renderAdd(outB, 0, 1);
    // With env3Prev reset to 0, A's route is inert on the first frame ⇒ A==B.
    expect(outA[0]).toBeCloseTo(outB[0], 6);
  });

  it('setEnvLoop(_,_,true) keeps env3 cycling so its routed output differs from loop-off', () => {
    const levelIdx = PARAM_INDEX['osc1.level'];
    const env3Src = MOD_SOURCES.indexOf('env3');
    const render = (loop: boolean) => {
      const v = new Voice(SR, 1);
      v.slots[PARAM_INDEX['env3.a']].setBase(0.005);
      v.slots[PARAM_INDEX['env3.d']].setBase(0.01);
      v.slots[PARAM_INDEX['env3.s']].setBase(0);
      v.setEnvLoop(false, false, loop);
      v.setMatrixSlot(0, env3Src, levelIdx, 1);
      v.noteOn(220, 1.0, SR);
      const out = new Float32Array(8192);
      v.renderAdd(out, 0, 8192);
      return out;
    };
    // loop off: env3 decays to 0 (s=0) and stays → no mod after ~15ms.
    // loop on: env3 keeps cycling → keeps modulating. The two diverge.
    const off = render(false), on = render(true);
    let maxDiff = 0;
    for (let i = 0; i < off.length; i++) maxDiff = Math.max(maxDiff, Math.abs(off[i] - on[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });
});
```
`Voice`, `MOD_SOURCES`, and `PARAM_INDEX` are already imported at the top of `Voice.test.ts`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @fiddle/client -- Voice.test`
Expected: FAIL — env3 route produces no modulation (source still 0), `v.setEnvLoop is not a function`.

- [ ] **Step 3: Wire env3 into Voice**

In `packages/client/src/engine/synth2/kernel/Voice.ts`:

(a) Add the source-index const beside the others (line ~28):
```ts
const SRC_LFO1 = MOD_SOURCES.indexOf('lfo1');
const SRC_LFO2 = MOD_SOURCES.indexOf('lfo2');
const SRC_ENV3 = MOD_SOURCES.indexOf('env3');
```

(b) Add the env3 field beside env1/env2 (around lines 49 / 82) and its prev field beside the other prevs (line ~65):
```ts
  private readonly env2: LoopEnvelope;
  private readonly env3: LoopEnvelope;
```
```ts
  private env1Prev = 0;
  private env2Prev = 0;
  private env3Prev = 0;
  private noisePrev = 0;
  private lfo1Prev = 0;
  private lfo2Prev = 0;
```

(c) Construct env3 in the constructor, beside env2 (after the `this.env2 = new LoopEnvelope(...)` block, ~line 87):
```ts
    this.env3 = new LoopEnvelope(
      slot('env3.a'), slot('env3.d'), slot('env3.s'), slot('env3.r'), sampleRate,
    );
```

(d) Add the `setEnvLoop` method beside `setSync` / `setFilterType` (after `setFilterType`, ~line 107):
```ts
  /** Block-boundary discrete toggle: loop mode for the three envelopes
   *  (spec §5.4). Mirrors setSync — applied per block, no smoother. */
  setEnvLoop(env1Loop: boolean, env2Loop: boolean, env3Loop: boolean): void {
    this.env1.setLoop(env1Loop);
    this.env2.setLoop(env2Loop);
    this.env3.setLoop(env3Loop);
  }
```

(e) In `noteOn`, retrigger env3 and clear its prev. Add to the prev-reset group (~line 124) and beside the `this.env2.noteOn(gateFrames)` (~line 136):
```ts
    this.env1Prev = 0;
    this.env2Prev = 0;
    this.env3Prev = 0;
    this.noisePrev = 0;
    this.lfo1.reset();
    this.lfo2.reset();
    this.lfo1Prev = 0;
    this.lfo2Prev = 0;
```
```ts
    this.env1.noteOn(gateFrames);
    this.env2.noteOn(gateFrames);
    this.env3.noteOn(gateFrames);
```

(f) In `renderAdd`, feed env3Prev into the matrix at the loop **top** (beside the other source fills, ~line 149):
```ts
      this.sources[SRC_LFO1] = this.lfo1Prev;
      this.sources[SRC_LFO2] = this.lfo2Prev;
      this.sources[SRC_ENV3] = this.env3Prev;
```

(g) At the loop **bottom**, advance env3 and capture it (beside the other prev captures, ~line 188):
```ts
      this.lfo1Prev = this.lfo1.next();
      this.lfo2Prev = this.lfo2.next();
      this.env3Prev = this.env3.next();
```

`Voice.active` stays `this.env1.active` (unchanged): env3 modulates but does not keep the voice alive.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Voice.test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Voice.ts packages/client/src/engine/synth2/kernel/Voice.test.ts
git commit -m "feat(client): wire env3 source + setEnvLoop into Voice (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 6: Client kernel — Synth2Kernel loop decode

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`. It imports `MOD_SOURCES` from `@fiddle/shared` (add to the existing import if absent) and reuses the `SR`/imports already present:
```ts
describe('Synth2Kernel env loop decode (I3c)', () => {
  const SR = 48000;

  it('decodes env3.loop and drives it to the voices (looping env3 mod differs from non-looping)', () => {
    const env3Src = MOD_SOURCES.indexOf('env3');
    const levelIdx = PARAM_INDEX['osc1.level'];
    const render = (loopVal: number) => {
      const k = new Synth2Kernel(SR);
      const block = defaultParamBlock();
      block[PARAM_INDEX['env3.a']] = 0.005;
      block[PARAM_INDEX['env3.d']] = 0.01;
      block[PARAM_INDEX['env3.s']] = 0;
      block[PARAM_INDEX['env3.loop']] = loopVal;
      // matrix slot 0: env3 → osc1.level, amount 1 (destEnc = PARAM_INDEX + 1)
      const base = MATRIX_BASE + 0 * MATRIX_STRIDE;
      block[base] = env3Src;
      block[base + 1] = levelIdx + 1;
      block[base + 2] = 1;
      k.applyParams(block);
      k.noteOn(0, 220, 1, 1, true);
      const out = new Float32Array(8192);
      k.process(out, 8192, 0);
      return out;
    };
    const off = render(0), on = render(1);
    let maxDiff = 0;
    for (let i = 0; i < off.length; i++) maxDiff = Math.max(maxDiff, Math.abs(off[i] - on[i]));
    expect(maxDiff).toBeGreaterThan(0.01);
  });
});
```
Confirm the imports at the top of the test include `MATRIX_BASE`, `MATRIX_STRIDE`, `defaultParamBlock`, `PARAM_INDEX` (they do, line ~3) and add `MOD_SOURCES` from `@fiddle/shared` and `Synth2Kernel` (already imported).

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: FAIL — without the decode, `env3.loop` never reaches the voices, so loop-on and loop-off render identically (`maxDiff` ≈ 0).

- [ ] **Step 3: Decode the loop bools in applyParams**

In `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`, in `applyParams`, beside the existing `osc2Sync`/`osc3Sync`/`filterType` decode (lines ~60–65):
```ts
    const osc2Sync = this.block[PARAM_INDEX['osc2.sync']] >= 0.5;
    const osc3Sync = this.block[PARAM_INDEX['osc3.sync']] >= 0.5;
    const filterType = Math.round(this.block[PARAM_INDEX['filter.type']]);
    const env1Loop = this.block[PARAM_INDEX['env1.loop']] >= 0.5;
    const env2Loop = this.block[PARAM_INDEX['env2.loop']] >= 0.5;
    const env3Loop = this.block[PARAM_INDEX['env3.loop']] >= 0.5;
    for (const voice of this.voices) {
      voice.setSync(osc2Sync, osc3Sync);
      voice.setFilterType(filterType);
      voice.setEnvLoop(env1Loop, env2Loop, env3Loop);
    }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): decode env loop toggles at the block boundary (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 7: Client engine encode + sync (loop flushes immediately)

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts:204-211` (add `'loop'` to `DISCRETE_LEAF_FIELDS`)
- Test: `packages/client/src/engine/Synth2Engine.test.ts`
- Test: `packages/client/src/composables/useSynth.test.ts`

The engine descriptor-walk already encodes any `params.<module>.<field>`, including `kind:'bool'` leaves (proven by the `osc2.sync` tests) — so env3/loop encode with **no** engine code change. The one production edit is making the `loop` toggle flush immediately on the wire instead of riding the continuous throttle.

- [ ] **Step 1: Write the failing tests**

In `packages/client/src/engine/Synth2Engine.test.ts`, add inside the existing `describe('Synth2Engine boolean (discrete) params', …)` block (after the osc2.sync tests, ~line 140). The harness builds the engine inline and reads the posted block via `lastNode(engine).port.posted.at(-1)`:
```ts
  it('encodes env1.loop=true as 1 in the posted block (I3c)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ env1: { loop: true } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.block[PARAM_INDEX['env1.loop']]).toBe(1);
  });

  it('encodes an env3 ADSR leaf onto its descriptor index (I3c)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ env3: { a: 1.5 } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.block[PARAM_INDEX['env3.a']]).toBeCloseTo(1.5);
  });
```

In `packages/client/src/composables/useSynth.test.ts`, add beside the `osc2.sync` emit test (~line 339):
```ts
  it('emits a synth2 env1.loop toggle immediately (discrete leaf) (I3c)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].engines.synth2.env1.loop = true;
    // No timer advance: 'loop' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'env1', 'loop']));
    expect(op).toBeDefined();
    expect(op.value).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify the sync one fails**

Run: `npm test -w @fiddle/client -- Synth2Engine useSynth`
Expected: the two `Synth2Engine` encode tests PASS already (descriptor-walk covers them). The `useSynth` `env1.loop` test FAILS — without `'loop'` in `DISCRETE_LEAF_FIELDS`, the toggle rides the 50ms throttle, so no op is sent before the timer advances (`op` is undefined).

- [ ] **Step 3: Add `'loop'` to DISCRETE_LEAF_FIELDS**

In `packages/client/src/composables/useSynth.ts` (line ~204):
```ts
const DISCRETE_LEAF_FIELDS = new Set<string>([
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType', 'patternLength', 'enabled',
  'sync', // synth2 osc hard-sync toggle: an instantaneous discrete flip, like muted/soloed
  'loop', // synth2 envelope loop toggle (I3c): a discrete flip — flush immediately
  'type', // synth2 filter.type enum: a discrete selector flip — flush immediately
  'source', // synth2 matrix route source enum — discrete selector flip
  'dest',   // synth2 matrix route dest enum — discrete selector flip
  // ('amount' is intentionally NOT here — a continuous knob that rides the throttle.)
]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @fiddle/client -- Synth2Engine useSynth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/engine/Synth2Engine.test.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): flush env loop toggle immediately + encode locks (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 8: Client UI — Synth2Panel LOOP buttons + ENV 3 column

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts` (already exists; its harness is `mountPanel(params: object): HTMLElement` returning the host element — tests assert via `el.querySelectorAll`/`el.textContent` and click buttons directly)

- [ ] **Step 1: Write the failing component test**

Append to `packages/client/src/components/Synth2Panel.test.ts` (the `mountPanel` helper and the `Synth2Engine` import already exist at the top of the file):
```ts
describe('Synth2Panel envelope loop + ENV 3 (I3c)', () => {
  it('renders the ENV 3 column', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect((el.textContent || '').toUpperCase()).toContain('ENV 3');
  });

  it('renders a LOOP toggle on AMP ENV, FILTER ENV, and ENV 3 (3 total)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const loopBtns = el.querySelectorAll<HTMLButtonElement>('.loop-btn');
    expect(loopBtns.length).toBe(3);
  });

  it('toggles env1.loop and env3.loop via the LOOP buttons', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    // DOM order follows column order: [0] AMP ENV (env1), [1] FILTER ENV (env2), [2] ENV 3 (env3).
    const loopBtns = el.querySelectorAll<HTMLButtonElement>('.loop-btn');
    expect(params.env1.loop).toBe(false);
    loopBtns[0].click();
    expect(params.env1.loop).toBe(true);
    loopBtns[2].click();
    expect(params.env3.loop).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: FAIL — no `ENV 3` text, no `.loop-btn` buttons.

- [ ] **Step 3: Add the LOOP buttons + ENV 3 column**

In `packages/client/src/components/Synth2Panel.vue`:

(a) AMP ENV group (column 1) — add a LOOP button after the `</div>` that closes its `knob-row` (~line 42), inside the `module-group`:
```html
      <div class="module-group">
        <h3>AMP ENV</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.a" v-model="params.env1.a" :syncPath="ks.pathFor(['env1', 'a'])" @gesture-end="ks.end(['env1', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.d" v-model="params.env1.d" :syncPath="ks.pathFor(['env1', 'd'])" @gesture-end="ks.end(['env1', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env1.s" v-model="params.env1.s" :syncPath="ks.pathFor(['env1', 's'])" @gesture-end="ks.end(['env1', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env1.r" v-model="params.env1.r" :syncPath="ks.pathFor(['env1', 'r'])" @gesture-end="ks.end(['env1', 'r'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env1.loop }" @click="params.env1.loop = !params.env1.loop">LOOP</button>
      </div>
```

(b) FILTER ENV group (column 6) — add the same LOOP button after its `knob-row` (~line 135), bound to `params.env2.loop`:
```html
        <button type="button" class="loop-btn" :class="{ active: params.env2.loop }" @click="params.env2.loop = !params.env2.loop">LOOP</button>
```
(place it inside the FILTER ENV `module-group`, after the closing `</div>` of its `knob-row`.)

(c) New ENV 3 column — insert a whole new `rack-column` **after** the Filter envelope column (current column 6, ~line 137) and **before** the LFOs column:
```html
    <!-- Column 7: Mod envelope (env3) -->
    <div class="rack-column">
      <div class="module-group">
        <h3>ENV 3</h3>
        <div class="knob-row">
          <Knob label="A" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env3.a" v-model="params.env3.a" :syncPath="ks.pathFor(['env3', 'a'])" @gesture-end="ks.end(['env3', 'a'])" />
          <Knob label="D" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env3.d" v-model="params.env3.d" :syncPath="ks.pathFor(['env3', 'd'])" @gesture-end="ks.end(['env3', 'd'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env3.s" v-model="params.env3.s" :syncPath="ks.pathFor(['env3', 's'])" @gesture-end="ks.end(['env3', 's'])" />
          <Knob label="R" :min="0.001" :max="10" :step="0.001" format="ms" :defaultValue="DEFAULTS.env3.r" v-model="params.env3.r" :syncPath="ks.pathFor(['env3', 'r'])" @gesture-end="ks.end(['env3', 'r'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env3.loop }" @click="params.env3.loop = !params.env3.loop">LOOP</button>
      </div>
    </div>
```
Update the existing comments so the column numbering stays readable: the LFOs become "Column 8", the mod matrix "Column 9", the visualizer "Column 10". (These are HTML comments only; no logic depends on them.)

(d) Reuse the existing toggle button styling: extend the `.sync-btn` CSS rule selectors to also match `.loop-btn`. In the `<style scoped>` block, change every `.sync-btn` selector group to include `.loop-btn`:
```css
.sync-btn,
.loop-btn {
  width: 100%;
  margin-top: 6px;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 10px;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sync-btn:hover,
.loop-btn:hover { color: #aaa; border-color: #444; }
.sync-btn.active,
.loop-btn.active { background: #222; color: #fff; border-color: #555; }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel ENV 3 column + LOOP toggles (I3c)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Final verification (after all tasks)

- [ ] **Full gate, all workspaces:**
  Run: `npm run typecheck && npm test && npm run build`
  Expected: green across `@fiddle/shared`, `@fiddle/client`, `@fiddle/server`; build still emits `packages/client/public/worklets/synth2-processor.js` and (spot-check) it contains the loop branch (`grep -c "setLoop" packages/client/public/worklets/synth2-processor.js` ≥ 1).

- [ ] **Allocation discipline:** confirm `LoopEnvelope.next()` (loop branch), `Voice.renderAdd`, and `Synth2Kernel.applyParams`/`process` add no `new`/array growth in the hot path (env3 is preallocated per voice; the loop branch is pure arithmetic + stage assignment).

- [ ] **Browser verify (Playwright MCP, then CLOSE the session — AGENTS.md rule):**
  1. `npm run dev`; open/create a session; add a synth2 track.
  2. In the matrix, route `env3 → filter.cutoff` (amount > 0); enter a step; Play — confirm the cutoff is swept by env3's contour on each note (env3 is no longer inert).
  3. Click **LOOP** on ENV 3 (and on AMP ENV) with a held/long step — confirm the contour cycles continuously while gated, and stops/releases on note-off.
  4. Two-client check (reuse the sync harness): toggle `env1.loop` and move an `env3` knob in client A; confirm client B converges and hears the change.
  5. **Close the browser/session.**

- [ ] Keep the branch after verify — the user browser-verifies before merge (do not auto-merge, do not push).

## Roadmap after I3c (context only — separate plan/branch)

- **I3d** — Morph filter: `filter.model` enum (`classic`|`morph`) + `filter.morph` continuous LP↔BP↔HP, behind the existing `FilterModule` seam (`ClassicFilter` stays; add `MorphFilter` on `SvfCore`). Descriptor table grows append-only.
