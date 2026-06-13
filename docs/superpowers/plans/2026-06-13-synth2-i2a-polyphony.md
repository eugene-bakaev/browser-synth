# synth2 I2a — Polyphony + 8-voice allocator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `synth2` worklet engine polyphonic — an 8-voice kernel allocator (round-robin among free voices, steal oldest active when none free), a `mono`/`poly` mode like synth1, and the UI/sequencer wiring so a user can set a synth2 track to poly and hear a chord (and a second client converges).

**Architecture:** I1 left the extension points in place: `Synth2Kernel` already holds a one-element `Voice[]` with per-voice gating, and each `Voice` is self-contained with its own envelope gate. I2a grows the pool to 8, adds a pure `pickVoice` allocator, threads a `mono` flag through the trigger protocol (scalar freq ⇒ mono/voice-0, array ⇒ poly/allocate), adds a top-level `mode` enum to the synth2 params (sibling of `osc1`/`env1`, exactly like `engines.synth.mode`), and mirrors synth1's poly path in the panel, sequencer, and Tracker. The sync layer needs only one accept-list entry — the existing generic engine-slice diff watcher already emits `engines.synth2.mode`.

**Tech Stack:** TypeScript, Vue 3, Web Audio AudioWorklet, Zod (wire schema), Vitest, npm workspaces (`@fiddle/shared`, `@fiddle/client`).

**Scope (this plan is I2a only):** osc1/env1 voice + polyphony. **Out of scope:** oscs 2/3, noise, mixer, hard sync, TZFM (I2b); `FilterModule`/`ClassicFilter`/env2/keytrack (I2c); the `sessions.ts` `as unknown as Project` double-cast (orthogonal — adding the `mode` enum does not make the descriptor-generated numeric modules infer precisely).

**Branch:** `feat/synth2-i2a-polyphony` off `main`. Never commit on `main`.

**Gate commands** (per the project):
- Per workspace, fast: `npm test -w @fiddle/shared` / `npm test -w @fiddle/client` (vitest). Filter to one file with e.g. `npm test -w @fiddle/client -- Synth2Kernel`.
- Full merge gate before verify: `npm run typecheck && npm test && npm run build` (all 3 workspaces; build must still emit `packages/client/public/worklets/synth2-processor.js`).

---

### Task 0: Create the branch

- [ ] **Step 1: Branch off main**

```bash
git checkout main && git pull --ff-only
git checkout -b feat/synth2-i2a-polyphony
```

---

### Task 1: Shared — add `mode: 'mono' | 'poly'` to synth2 params

The `mode` enum is NOT a numeric descriptor (it can't live in `SYNTH2_DESCRIPTORS`, which generates the Float32Array block). It sits alongside `osc1`/`env1`, exactly like `engines.synth.mode` (`packages/shared/src/engines/synth.ts:37`, default `'mono'` at `:59`).

**Files:**
- Modify: `packages/shared/src/engines/synth2.ts`
- Modify: `packages/shared/src/project/schema.ts:103-107`
- Test: `packages/shared/src/engines/synth2.test.ts`, `packages/shared/src/project/schema.test.ts:91-103`

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/engines/synth2.test.ts`, add to the existing `describe('DEFAULT_SYNTH2_PARAMS', …)`:

```ts
  it('defaults mode to mono', () => {
    expect((DEFAULT_SYNTH2_PARAMS as any).mode).toBe('mono');
  });
```

In `packages/shared/src/project/schema.test.ts`, inside `describe('synth2 schema (generated from descriptors)', …)` add:

```ts
  it('accepts mono and poly mode and rejects anything else', () => {
    const ok = { ...DEFAULT_SYNTH2_PARAMS, mode: 'poly' as const };
    expect(Schemas.Synth2Params.safeParse(ok).success).toBe(true);
    const bad = { ...DEFAULT_SYNTH2_PARAMS, mode: 'chord' };
    expect(Schemas.Synth2Params.safeParse(bad).success).toBe(false);
  });
```

(If `DEFAULT_SYNTH2_PARAMS` isn't already imported in `schema.test.ts`, import it from `'../engines/synth2.js'`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fiddle/shared -- synth2 schema`
Expected: FAIL — `mode` is `undefined`; schema has no `mode` so `'chord'` is silently stripped and `safeParse` succeeds (assertion fails).

- [ ] **Step 3: Implement**

In `packages/shared/src/engines/synth2.ts`, extend the interface and the generated default:

```ts
export interface Synth2EngineParams {
  osc1: Synth2OscParams;
  env1: Synth2EnvParams;
  // Play mode — sequencer-level, like engines.synth.mode. Not a descriptor
  // (it's not a Float32Array param); lives here so presets carry their mode.
  mode: 'mono' | 'poly';
}

function buildDefaults(): Synth2EngineParams {
  const out: Record<string, Record<string, number>> = {};
  for (const d of SYNTH2_DESCRIPTORS) {
    const [mod, field] = d.key.split('.');
    (out[mod] ??= {})[field] = d.default;
  }
  return { ...(out as unknown as Synth2EngineParams), mode: 'mono' };
}
```

In `packages/shared/src/project/schema.ts`, add `mode` to the generated object (the outer `z.object` is not `.strict()`, so add the literal sibling):

```ts
const Synth2ParamsSchema = z.object({
  ...Object.fromEntries(
    Object.entries(synth2Modules).map(([mod, fields]) => [mod, z.object(fields).strict()]),
  ),
  mode: z.union([z.literal('mono'), z.literal('poly')]),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/shared`
Expected: PASS. The existing descriptor-derivation test (`mirrors the descriptor table exactly`) still passes — its leaf count compares `Object.values(...).reduce(...)` over the module objects; `mode` is a string scalar, not a module object, but it WILL be counted by that reducer's `Object.keys(m)` only if iterated as a module. **Check this:** the reducer in `synth2.test.ts:14-16` does `Object.values(DEFAULT_SYNTH2_PARAMS).reduce((n, m) => n + Object.keys(m).length, 0)`. `Object.values` now includes the string `'mono'`; `Object.keys('mono')` is `['0','1','2','3']` → length 4, breaking the count. **Fix that test** in this step to skip non-object values:

```ts
    const leafCount = Object.values(DEFAULT_SYNTH2_PARAMS)
      .filter(m => m !== null && typeof m === 'object')
      .reduce((n, m) => n + Object.keys(m).length, 0);
    expect(leafCount).toBe(SYNTH2_DESCRIPTORS.length);
```

Re-run `npm test -w @fiddle/shared` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts packages/shared/src/project/schema.ts packages/shared/src/project/schema.test.ts
git commit -m "feat(shared): synth2 gains a mono/poly mode param (sibling of osc1/env1)"
```

---

### Task 2: Sync + healing — synth2.mode round-trips and old snapshots heal

The engine-slice diff watcher (`useSynth.ts:355` loop over `ENGINE_SLICES`) already emits `engines.synth2.mode` as a leaf op; `resolveLeafSchema` already resolves `tracks.i.engines.synth2.mode` via its `tokens.length === 5` branch (`accept-list.ts:192-196`) now that `mode` is in the schema shape. The ONLY missing piece is the writable-path entry. Healing of a pre-I2a snapshot lacking `mode` is automatic via `reconcileTrack`'s `deepMerge(Synth2Engine.DEFAULT_PARAMS, …)` (`storage.ts:43`) — add a regression test.

**Files:**
- Modify: `packages/shared/src/project/accept-list.ts:70-72`
- Test: `packages/shared/src/project/accept-list.test.ts:117`
- Test: `packages/client/src/project/storage.test.ts` (or `reconcile.test.ts`)

- [ ] **Step 1: Write the failing tests**

In `packages/shared/src/project/accept-list.test.ts`, inside `describe('synth2 accept-list (generated from descriptors)', …)` add:

```ts
  it('allows synth2 mode and validates its value', () => {
    expect(pathIsWritable('tracks.0.engines.synth2.mode')).toBe(true);
    expect(validatePathAndValue('tracks.0.engines.synth2.mode', 'poly')).toEqual({ ok: true });
    const bad = validatePathAndValue('tracks.0.engines.synth2.mode', 'chord');
    expect(bad.ok).toBe(false);
  });
```

In `packages/client/src/project/storage.test.ts` (the file that exercises `reconcileWithDefaults`), add:

```ts
  it('heals a synth2 slice missing mode to mono', () => {
    const loaded = {
      schemaVersion: 2,
      bpm: 120,
      tracks: [{ engineType: 'synth2', engines: { synth2: { osc1: { morph: 1 } } } }],
    };
    const out = reconcileWithDefaults(loaded);
    expect(out.tracks[0].engines.synth2.mode).toBe('mono');
  });
```

(Match the import style already used in that test file for `reconcileWithDefaults`.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -w @fiddle/shared -- accept-list` then `npm test -w @fiddle/client -- storage`
Expected: accept-list FAILS (`pathIsWritable` false — pattern missing). storage test PASSES already IF `deepMerge` fills defaults (it should, since `DEFAULT_SYNTH2_PARAMS` now has `mode`) — if it already passes, keep it as a guard and note that; if it fails, the deepMerge default isn't applied and Step 3 covers it.

- [ ] **Step 3: Implement**

In `packages/shared/src/project/accept-list.ts`, add the `mode` pattern right after the generated synth2 leaf patterns (around line 72):

```ts
  // Synth2 params — GENERATED from the descriptor table (spec §6.4): one
  // leaf pattern per descriptor, nested as engines.synth2.<module>.<field>.
  ...SYNTH2_DESCRIPTORS.map(d => ['tracks', '*', 'engines', 'synth2', ...d.key.split('.')]),
  // synth2 play mode — not a descriptor, sibling of the modules (like synth.mode).
  ['tracks', '*', 'engines', 'synth2', 'mode'],
```

No change to `resolveLeafSchema` — the `tokens.length === 5` branch already returns `Synth2ParamsSchema.shape.mode`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -w @fiddle/shared -- accept-list` and `npm test -w @fiddle/client -- storage`
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/project/accept-list.ts packages/shared/src/project/accept-list.test.ts packages/client/src/project/storage.test.ts
git commit -m "feat(shared): allow engines.synth2.mode on the sync accept-list; heal-on-load test"
```

---

### Task 3: Kernel — pure `pickVoice` allocator

A pure function so the allocation policy is deterministic and unit-tested without audio. Free-first round-robin starting at `rrStart`; steal the oldest (smallest age) active voice when none are free.

**Files:**
- Create: `packages/client/src/engine/synth2/kernel/allocator.ts`
- Test: `packages/client/src/engine/synth2/kernel/allocator.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// packages/client/src/engine/synth2/kernel/allocator.test.ts
import { describe, it, expect } from 'vitest';
import { pickVoice } from './allocator';

describe('pickVoice', () => {
  const ages = [0, 0, 0, 0, 0, 0, 0, 0];

  it('returns the round-robin start when it is free', () => {
    const active = new Array(8).fill(false);
    expect(pickVoice(active, ages, 3)).toBe(3);
  });

  it('skips active voices, scanning forward (wrapping) from rrStart', () => {
    const active = [false, false, true, true, false, false, false, false];
    // rrStart 2 is active, 3 active, 4 free
    expect(pickVoice(active, ages, 2)).toBe(4);
    // wraps past the end
    const active2 = [false, true, true, true, true, true, true, true];
    expect(pickVoice(active2, ages, 6)).toBe(0);
  });

  it('steals the oldest (smallest age) active voice when none are free', () => {
    const active = new Array(8).fill(true);
    const someAges = [50, 10, 90, 30, 70, 5, 60, 40];
    expect(pickVoice(active, someAges, 0)).toBe(5); // age 5 is oldest
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fiddle/client -- allocator`
Expected: FAIL — `pickVoice` not defined.

- [ ] **Step 3: Implement**

```ts
// packages/client/src/engine/synth2/kernel/allocator.ts
//
// Voice allocation policy (spec §5.6): prefer a FREE voice, scanning round-robin
// from rrStart so successive notes spread across the pool; when every voice is
// busy, STEAL the oldest active one (smallest age stamp). Pure + allocation-free
// so the kernel's hot path stays GC-clean and the policy is unit-testable.

export const VOICE_COUNT = 8;

/**
 * @param active per-voice activity (length VOICE_COUNT)
 * @param ages   per-voice age stamp; smaller = older (length VOICE_COUNT)
 * @param rrStart round-robin scan origin
 * @returns index of the voice to (re)trigger
 */
export function pickVoice(active: boolean[], ages: number[], rrStart: number): number {
  const n = active.length;
  for (let k = 0; k < n; k++) {
    const v = (rrStart + k) % n;
    if (!active[v]) return v;
  }
  // None free → steal the oldest active.
  let oldest = 0;
  for (let v = 1; v < n; v++) {
    if (ages[v] < ages[oldest]) oldest = v;
  }
  return oldest;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @fiddle/client -- allocator`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/allocator.ts packages/client/src/engine/synth2/kernel/allocator.test.ts
git commit -m "feat(client): pure pickVoice allocator (free-first round-robin, steal oldest)"
```

---

### Task 4: Kernel — 8-voice pool, `mono` routing, allocator wiring

Grow the pool to `VOICE_COUNT`, thread a `mono` flag through `noteOn`/`NoteEvent`, and route mono triggers to voice 0 (reusing the I1 steal ramp) vs poly triggers through `pickVoice`. `applyParams` and `renderActive` already loop all voices — they work unchanged for 8.

**Files:**
- Modify: `packages/client/src/engine/synth2/kernel/Synth2Kernel.ts`
- Test: `packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `Synth2Kernel.test.ts`. White-box reach into the voices like the engine test reaches into `node`:

```ts
function activeCount(kernel: Synth2Kernel): number {
  return (kernel as any).voices.filter((v: any) => v.active).length;
}

describe('Synth2Kernel polyphony', () => {
  it('sounds 8 simultaneous poly voices and never grows past 8', () => {
    const kernel = new Synth2Kernel(SR);
    for (let i = 0; i < 12; i++) kernel.noteOn(0, 220 + i * 30, 2, 1, false); // mono=false → poly
    renderBlocks(kernel, 0, 4);
    expect((kernel as any).voices.length).toBe(8);
    expect(activeCount(kernel)).toBe(8); // 12 notes, 8 voices, oldest stolen
  });

  it('mono triggers only ever use voice 0', () => {
    const kernel = new Synth2Kernel(SR);
    kernel.noteOn(0, 220, 2, 1, true);
    kernel.noteOn(0, 330, 2, 1, true);
    kernel.noteOn(0, 440, 2, 1, true);
    renderBlocks(kernel, 0, 4);
    expect((kernel as any).voices[0].active).toBe(true);
    expect(activeCount(kernel)).toBe(1);
  });

  it('prefers a freed voice over stealing (free-first)', () => {
    const kernel = new Synth2Kernel(SR);
    const block = defaultParamBlock();
    block[PARAM_INDEX['env1.r']] = 0.001;
    kernel.applyParams(block);
    kernel.noteOn(0, 220, 0.01, 1, false); // very short — will free quickly
    kernel.noteOn(0, 330, 2, 1, false);    // long — stays active
    renderBlocks(kernel, 0, Math.ceil((SR * 0.2) / BLOCK)); // let the short note finish
    expect(activeCount(kernel)).toBe(1);   // only the long note remains
    kernel.noteOn(SR * 0.2 / SR, 440, 2, 1, false);
    renderBlocks(kernel, Math.ceil((SR * 0.2) / BLOCK) * BLOCK, 4);
    expect(activeCount(kernel)).toBe(2);   // reused a free voice, didn't steal the long note
  });
});
```

Also update the existing `Synth2Kernel.test.ts` calls to `noteOn(...)` (they pass 4 args) — add the trailing `mono` arg. The simplest is to make `mono` the last param and default it; tests that omit it should still mono-route. **Decision:** give `noteOn` a defaulted `mono = true` so existing 4-arg calls keep working (they were mono). The new poly tests pass `false` explicitly. This keeps the existing tests untouched.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: FAIL — `noteOn` arity / poly behavior not implemented; `voices.length` is 1.

- [ ] **Step 3: Implement**

In `Synth2Kernel.ts`:

```ts
import { Voice } from './Voice';
import { PARAM_COUNT, defaultParamBlock } from './params';
import { pickVoice, VOICE_COUNT } from './allocator';

const MAX_EVENTS = 64;

interface NoteEvent {
  frame: number;
  freq: number;
  gateFrames: number;
  velocity: number;
  mono: boolean;
}

export class Synth2Kernel {
  private readonly voices: Voice[];
  private readonly block: Float32Array = defaultParamBlock();
  private readonly events: NoteEvent[];
  private head = 0;
  private count = 0;

  // Allocator state. activeScratch is reused per allocate() so the hot path
  // never allocates. ages: monotonic stamp per voice; smaller = older.
  private readonly activeScratch: boolean[] = new Array(VOICE_COUNT).fill(false);
  private readonly ages: number[] = new Array(VOICE_COUNT).fill(0);
  private rr = 0;
  private ageCounter = 1;

  constructor(private readonly sampleRate: number) {
    this.voices = Array.from({ length: VOICE_COUNT }, () => new Voice(sampleRate));
    this.events = Array.from({ length: MAX_EVENTS }, () => ({
      frame: 0, freq: 440, gateFrames: 0, velocity: 1, mono: true,
    }));
  }

  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) this.block[i] = block[i];
    for (const voice of this.voices) {
      for (let i = 0; i < n; i++) voice.slots[i].setBase(this.block[i]);
    }
  }

  /** mono=true retriggers voice 0; mono=false allocates a poly voice. */
  noteOn(time: number, freq: number, duration: number, velocity: number, mono = true): void {
    if (this.count === MAX_EVENTS) {
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(time * this.sampleRate);
    ev.freq = freq;
    ev.gateFrames = Math.max(1, Math.round(duration * this.sampleRate));
    ev.velocity = velocity;
    ev.mono = mono;
    this.count++;
  }

  process(out: Float32Array, frames: number, blockStartFrame: number): void {
    out.fill(0);
    let cursor = 0;
    while (this.count > 0) {
      const ev = this.events[this.head];
      if (ev.frame >= blockStartFrame + frames) break;
      const offset = Math.max(0, ev.frame - blockStartFrame);
      this.renderActive(out, cursor, offset);
      cursor = offset;
      const v = ev.mono ? 0 : this.allocate();
      this.voices[v].noteOn(ev.freq, ev.velocity, ev.gateFrames);
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    this.renderActive(out, cursor, frames);
  }

  private allocate(): number {
    for (let v = 0; v < VOICE_COUNT; v++) this.activeScratch[v] = this.voices[v].active;
    const v = pickVoice(this.activeScratch, this.ages, this.rr);
    this.rr = (v + 1) % VOICE_COUNT;
    this.ages[v] = this.ageCounter++;
    return v;
  }

  private renderActive(out: Float32Array, from: number, to: number): void {
    if (to <= from) return;
    for (const voice of this.voices) {
      if (voice.active) voice.renderAdd(out, from, to);
    }
  }
}
```

Update the header comment of `Synth2Kernel.ts` (lines 9-12) to say I2a is poly: 8 voices, mono retriggers voice 0, poly allocates via `pickVoice`.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @fiddle/client -- Synth2Kernel`
Expected: PASS (new poly suite + all existing I1 cases, which now pass `mono` by default).

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/synth2/kernel/Synth2Kernel.ts packages/client/src/engine/synth2/kernel/Synth2Kernel.test.ts
git commit -m "feat(client): synth2 kernel grows to 8 voices with mono/poly routing"
```

---

### Task 5: Worklet protocol — `mono` on the trigger message

**Files:**
- Modify: `packages/client/src/engine/synth2/worklet-entry.ts:13-16,42-43`

There is no Node-side unit test that imports `worklet-entry.ts` (it references `AudioWorkletProcessor`); it is type-checked and built. So the "test" here is the typecheck + the engine test (Task 6) which asserts the posted message shape, plus the kernel (Task 4) which owns the behavior.

- [ ] **Step 1: Implement**

Extend the message union and forward `mono`:

```ts
type Synth2Message =
  | { type: 'params'; block: Float32Array }
  | { type: 'trigger'; time: number; freq: number; duration: number; velocity: number; mono: boolean }
  | { type: 'dispose' };
```

```ts
      } else if (msg.type === 'trigger') {
        this.kernel.noteOn(msg.time, msg.freq, msg.duration, msg.velocity, msg.mono);
```

Update the protocol comment block (lines 6-9) to include `mono` on the trigger line.

- [ ] **Step 2: Verify it type-checks and builds the worklet**

Run: `npm run typecheck -w @fiddle/client && npm run build -w @fiddle/client`
Expected: PASS; `packages/client/public/worklets/synth2-processor.js` is re-emitted.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/engine/synth2/worklet-entry.ts
git commit -m "feat(client): synth2 worklet trigger message carries a mono flag"
```

---

### Task 6: Engine — `Synth2Engine.trigger` fans a chord to voices

Scalar freq ⇒ one mono message (voice 0). Array ⇒ one poly message per freq (allocator spreads them). This matches synth1's call convention (`useSynth.ts:772-776`: poly passes the array, mono passes a scalar).

**Files:**
- Modify: `packages/client/src/engine/Synth2Engine.ts:63-74`
- Test: `packages/client/src/engine/Synth2Engine.test.ts:85-90`

- [ ] **Step 1: Replace the failing test**

Replace the existing `it('trigger forwards the sequencer time and takes the first freq of a chord', …)` (lines 85-90) with:

```ts
  it('trigger posts a single mono message for a scalar freq', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.trigger(440, 0.5, 1.25, 0.8);
    const posted = lastNode(engine).port.posted.filter(m => m.type === 'trigger');
    expect(posted).toEqual([
      { type: 'trigger', time: 1.25, freq: 440, duration: 0.5, velocity: 0.8, mono: true },
    ]);
  });

  it('trigger fans a chord to one poly message per note', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.trigger([220, 330, 440], 0.5, 1.25, 0.8);
    const posted = lastNode(engine).port.posted.filter(m => m.type === 'trigger');
    expect(posted).toEqual([
      { type: 'trigger', time: 1.25, freq: 220, duration: 0.5, velocity: 0.8, mono: false },
      { type: 'trigger', time: 1.25, freq: 330, duration: 0.5, velocity: 0.8, mono: false },
      { type: 'trigger', time: 1.25, freq: 440, duration: 0.5, velocity: 0.8, mono: false },
    ]);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fiddle/client -- Synth2Engine`
Expected: FAIL — current `trigger` collapses the array to `freq[0]` and posts no `mono` field.

- [ ] **Step 3: Implement**

```ts
  trigger(freq: number | number[], duration: number, time?: number, velocity: number = 1.0): void {
    if (this.ctx.state === 'suspended') this.ctx.resume();
    const t = time ?? this.ctx.currentTime;
    if (Array.isArray(freq)) {
      // Poly: one message per note; the kernel allocator spreads them across voices.
      for (const f of freq) {
        this.node.port.postMessage({ type: 'trigger', time: t, freq: f, duration, velocity, mono: false });
      }
    } else {
      // Mono: voice 0 retrigger.
      this.node.port.postMessage({ type: 'trigger', time: t, freq, duration, velocity, mono: true });
    }
  }
```

Update the I1 mono comment (line 65) accordingly.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @fiddle/client -- Synth2Engine`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/engine/Synth2Engine.ts packages/client/src/engine/Synth2Engine.test.ts
git commit -m "feat(client): Synth2Engine.trigger fans a chord to poly voices"
```

---

### Task 7: Sequencer — synth2 branch reads mode and fans chords

Mirror the synth1 path. `resolveChordFreqs` and `noteToFreq` are already imported in `useSynth.ts` (lines 11-12).

**Files:**
- Modify: `packages/client/src/composables/useSynth.ts:778-783`
- Test: `packages/client/src/composables/useSynth.test.ts` (extend existing trigger-path coverage if present; otherwise add a focused test)

- [ ] **Step 1: Write/extend the failing test**

In `useSynth.test.ts`, add a test that a poly synth2 track fans a chord. Follow the file's existing harness for driving a sequencer tick with a stub engine. Minimal shape:

```ts
  it('synth2 poly step triggers a chord (multiple freqs)', () => {
    // ...arrange a project with one synth2 track, mode 'poly', a step with a note...
    // ...stub the synth2 engine's trigger and advance one tick...
    expect(triggerSpy).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(Number)]), // freqs array, not a scalar
      expect.any(Number), expect.any(Number), expect.any(Number),
    );
  });
```

If the existing test file has no sequencer-tick harness, assert the branch indirectly by unit-testing the smallest extracted helper; otherwise rely on the browser verification step for this branch and keep the unit assertion at the engine level (Task 6). Do not invent a harness that doesn't fit the file's patterns.

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: FAIL (scalar passed, not an array) — or, if no harness fits, skip to Step 3 and rely on Task 6 + browser verify (note this in the commit).

- [ ] **Step 3: Implement**

Replace the synth2 branch (lines 778-783):

```ts
            } else if (engineTypeI === 'synth2') {
              const currentMode = track.engines.synth2.mode;
              const tickDuration = (60 / project.bpm) / 4;
              const duration = step.length * tickDuration;
              if (currentMode === 'poly') {
                const freqs = resolveChordFreqs(step.note, step.chordType || 'maj', step.octave);
                engine.trigger(freqs, duration, time, step.velocity);
              } else {
                engine.trigger(noteToFreq(step.note, step.octave), duration, time, step.velocity);
              }
            } else {
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @fiddle/client -- useSynth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/composables/useSynth.ts packages/client/src/composables/useSynth.test.ts
git commit -m "feat(client): sequencer fans synth2 chords in poly mode"
```

---

### Task 8: UI — Synth2Panel mono/poly toggle

Mirror `SynthPanel.vue:3-21` (the `.synth-mode-selector` block) and copy its CSS (`SynthPanel.vue:84-105`). `params` is `EngineParamsMap['synth2']`, which now has `mode`, so `params.mode = 'mono' | 'poly'` type-checks. The change is picked up by the existing engine-slice sync watcher.

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Test: `packages/client/src/components/Synth2Panel.test.ts` (create if absent; otherwise extend)

- [ ] **Step 1: Write the failing test**

Mount the panel with a `params` containing `mode: 'mono'`, click the POLY button, assert `params.mode === 'poly'`. Use the test util style of the repo's other component tests (Vue Test Utils `mount`). Provide the minimal required props (`params`, `analyser: null`, `color`).

```ts
  it('toggles mode to poly on click', async () => {
    const params = { ...structuredClone(Synth2Engine.DEFAULT_PARAMS) };
    const wrapper = mount(Synth2Panel, { props: { params, analyser: null, color: '#fff' } });
    await wrapper.findAll('.mode-btn')[1].trigger('click'); // POLY
    expect(params.mode).toBe('poly');
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: FAIL — no `.mode-btn` exists yet.

- [ ] **Step 3: Implement**

In `Synth2Panel.vue`, add the selector as the first child of `.rack-columns` (before Column 1):

```html
  <div class="rack-columns">
    <!-- Mono/Poly toggle -->
    <div class="synth-mode-selector">
      <button type="button" class="mode-btn" :class="{ active: params.mode === 'mono' }" @click="params.mode = 'mono'">MONO</button>
      <button type="button" class="mode-btn" :class="{ active: params.mode === 'poly' }" @click="params.mode = 'poly'">POLY</button>
    </div>

    <!-- Column 1: Oscillator 1 -->
```

Add a `<style scoped>` block copying the `.synth-mode-selector` / `.mode-btn` rules from `SynthPanel.vue:84-105` (selector layout, hover, `.active`).

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @fiddle/client -- Synth2Panel`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): Synth2Panel mono/poly toggle"
```

---

### Task 9: UI — per-engine mode wiring + Tracker poly layout

I1 hardwired the Tracker `:mode` to `engines.synth.mode` for every engine (`StudioView.vue:47,143`) and gated `isPoly` on `engineType === 'synth'` (`Tracker.vue:271`). Source mode from each track's OWN engine, and let synth2 use the poly layout.

**Files:**
- Modify: `packages/client/src/views/StudioView.vue:47,143` + script
- Modify: `packages/client/src/components/Tracker.vue:266-271`
- Test: `packages/client/src/components/Tracker.test.ts` (extend; if absent, create a focused test)

- [ ] **Step 1: Write the failing test**

In a Tracker test, mount with `engineType: 'synth2'`, `mode: 'poly'`, and assert the chord-entry layout renders (assert on a selector unique to the poly layout — inspect the template's poly branch to pick a stable class/test-id; e.g. the poly header cell). Also assert `engineType: 'synth2'`, `mode: 'mono'` renders single-note entry.

```ts
  it('renders the poly chord layout for a synth2 poly track', () => {
    const wrapper = mount(Tracker, { props: { ...baseProps, engineType: 'synth2', mode: 'poly' } });
    expect(wrapper.find('<poly-layout selector>').exists()).toBe(true);
  });
```

(Pick `<poly-layout selector>` by reading the existing poly branch in `Tracker.vue` — reuse whatever the synth1 poly test already keys on, if one exists.)

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w @fiddle/client -- Tracker`
Expected: FAIL — `isPoly` is false for synth2.

- [ ] **Step 3: Implement**

In `Tracker.vue`, update the computed + comment (lines 266-271):

```ts
// Melodic engines (synth, synth2) get note/octave/length step entry; everything
// else gets the drum TRIG grid. Poly chord layout is gated on a melodic engine
// whose own mode is poly — StudioView now passes each track's own engine mode.
const isMelodic = computed(() => props.engineType === 'synth' || props.engineType === 'synth2');
const isPoly = computed(() => isMelodic.value && props.mode === 'poly');
```

In `StudioView.vue`, add a helper in `<script setup>` (import `ProjectTrack` from the project types if not already imported):

```ts
function trackMode(t: ProjectTrack): 'mono' | 'poly' {
  if (t.engineType === 'synth') return t.engines.synth.mode;
  if (t.engineType === 'synth2') return t.engines.synth2.mode;
  return 'mono'; // drums are not melodic; value is unused by the Tracker
}
```

Replace the two bindings:
- Line 47: `:mode="trackMode(project.tracks[entry.index])"`
- Line 143: `:mode="trackMode(focusedTrack!)"`

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w @fiddle/client -- Tracker`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/views/StudioView.vue packages/client/src/components/Tracker.vue packages/client/src/components/Tracker.test.ts
git commit -m "feat(client): synth2 poly Tracker layout + per-engine mode wiring"
```

---

### Task 10: Full gate + browser verification

- [ ] **Step 1: Run the full merge gate**

Run: `npm run typecheck && npm test && npm run build`
Expected: typecheck clean across all 3 workspaces; all unit tests pass; build emits `packages/client/public/worklets/synth2-processor.js`.

- [ ] **Step 2: Allocation-discipline spot check**

Re-read the kernel hot path (`Synth2Kernel.process`/`allocate`) and confirm no `new`, no array growth, no closure allocation per call — `activeScratch`/`ages` are preallocated; `pickVoice` allocates nothing. (Formal soak test is I4.)

- [ ] **Step 3: Browser verify with Playwright MCP, then close the session**

1. `npm run dev`; open a session; add a synth2 track and focus it.
2. In Synth2Panel click **POLY** → the Tracker switches to the chord-entry layout for that track.
3. Enter a chord step (root note + chordType); Play → all chord notes sound; overlapping steps stack voices and, past 8, steal the oldest (no stuck/runaway voices, no clicks).
4. Click **MONO** → single-note entry; monophonic playback (voice 0 retriggers, no overlap).
5. Two-client convergence (reuse the I1 sync harness): set synth2 to **poly** in client A; confirm client B's track flips to poly and plays the chord — verifies `engines.synth2.mode` syncs.
6. **Close the browser/session** (AGENTS.md cleanup rule).

- [ ] **Step 4: Leave the branch for user review**

Do NOT merge. Report gate + verification results; the user browser-verifies before merge (verify-before-finalizing).

---

## Self-review notes (coverage vs the I2a plan)

- `mode` param: Task 1 (type/default/schema), Task 2 (sync + heal), Task 8 (UI set), Task 9 (read into Tracker), Task 7 (read into sequencer). ✔
- 8 voices + allocator (free-first round-robin, steal oldest): Tasks 3–4. ✔
- mono reuses voice 0: Task 4. ✔
- chord trigger protocol: Tasks 5–6. ✔
- poly Tracker layout: Task 9. ✔
- old-snapshot healing + two-client convergence: Task 2 + Task 10 step 3.5. ✔
- Type consistency: `noteOn(time, freq, duration, velocity, mono=true)`, trigger message `{…, mono: boolean}`, `pickVoice(active, ages, rrStart)`, `VOICE_COUNT=8`, `trackMode(track)` — names used identically across tasks. ✔
- Out of scope held: no oscs 2/3, no filter, no env2, no `sessions.ts` change. ✔
