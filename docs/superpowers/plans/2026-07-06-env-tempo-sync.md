# Envelope A/D/R Tempo-Sync (synth2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-envelope SYNC toggle on synth2's env1/env2/env3 that switches Attack/Decay/Release from free seconds to musical note divisions locked to the project BPM.

**Architecture:** Reuses the LFO tempo-sync machinery merged in `d8a9e88` (spec `docs/superpowers/specs/2026-07-06-env-tempo-sync-design.md`): 12 append-only descriptor rows (per envelope: one `sync` bool + `aDiv`/`dDiv`/`rDiv` enums over `LFO_SYNC_LABELS`), a new shared `divisionToSeconds` helper, and main-thread derivation in `AudioEngine` (`effectiveEnvTimes`) at the same three sites `effectiveLfoRate` uses. The kernel stays tempo-agnostic — it keeps receiving seconds in the existing `env*.a/d/r` block slots; the new rows are dead block slots exactly like `lfo*.sync`/`lfo*.div`.

**Tech Stack:** TypeScript monorepo (`@fiddle/shared`, `@fiddle/client`), Vue 3.5 `<script setup>`, Vitest, Web Audio worklets.

## Global Constraints

- `SYNTH2_DESCRIPTORS` is **APPEND-ONLY**: the 12 new rows go at the END of the table, after `lfo2.div`, in exactly this order: `env1.sync, env1.aDiv, env1.dDiv, env1.rDiv, env2.sync, env2.aDiv, env2.dDiv, env2.rDiv, env3.sync, env3.aDiv, env3.dDiv, env3.rDiv`.
- Enum defaults are expressed as `LFO_SYNC_LABELS.indexOf('1/32' | '1/8' | '1/4')` — never hardcoded indices.
- The persisted `env*.a/d/r` leaves are **never overwritten** by sync (same invariant as `lfo*.rate`).
- The kernel/worklet is NOT modified; derived seconds are computed on the main thread only.
- Derived times are clamped to `[0.001, 10]` (defensive: BPM 40–240 yields 20.8 ms – 9.0 s, always in range).
- The new UI button class is `.env-sync-btn` — distinct from `.lfo-sync-btn` (count-of-2 test) and `.sync-btn` (osc hard-sync, count-of-2 test), both of which must stay green.
- Sustain (`env*.s`) and LOOP (`env*.loop`) are untouched in both modes.
- Local testing uses `npm run dev:obs` ONLY — never `npm run dev` (it targets the prod database).
- Stage only the files each commit names — never `git add -A`/`-u`. Never stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png` (untracked scratch at repo root).
- Branch: `feat/env-tempo-sync` (already checked out; spec committed `ff7bb02`).

---

## File Structure

| File | Responsibility | Task |
|---|---|---|
| `packages/shared/src/engines/lfo-sync.ts` | + `divisionToSeconds(label, bpm)` | 1 |
| `packages/shared/src/engines/lfo-sync.test.ts` | + `divisionToSeconds` tests | 1 |
| `packages/shared/src/engines/synth2-descriptors.ts` | + 12 append-only rows | 1 |
| `packages/shared/src/engines/synth2-descriptors.test.ts` | + row-shape test; extend `DISCRETE_KEYS` + tail-order list | 1 |
| `packages/shared/src/engines/synth2.ts` | `Synth2EnvParams` + `sync`/`aDiv`/`dDiv`/`rDiv` | 1 |
| `packages/shared/src/engines/synth2.test.ts` | + envelope-sync defaults test | 1 |
| `packages/client/src/audio/AudioEngine.ts` | + `effectiveEnvTimes`, wired at build / env-leaf / bpm sites | 2 |
| `packages/client/src/audio/AudioEngine.test.ts` | + envelope derivation test block | 2 |
| `packages/client/src/components/Synth2Panel.vue` | 3 × SYNC button + conditional A/D/R knobs + style | 3 |
| `packages/client/src/components/Synth2Panel.test.ts` | + envelope tempo-sync test block | 3 |

Schema, accept-list, `DEFAULT_SYNTH2_PARAMS`, and the kernel param-block layout all **derive automatically** from the descriptor table — no manual edits there.

---

### Task 1: Shared — `divisionToSeconds` + 12 descriptor rows + `Synth2EnvParams` fields

**Files:**
- Modify: `packages/shared/src/engines/lfo-sync.ts` (append after `divisionLabelToIndex`)
- Modify: `packages/shared/src/engines/lfo-sync.test.ts` (append describe block)
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (append rows after `lfo2.div`, ~line 167)
- Modify: `packages/shared/src/engines/synth2-descriptors.test.ts` (`DISCRETE_KEYS` line 9, tail-order list ~line 54, new test)
- Modify: `packages/shared/src/engines/synth2.ts` (`Synth2EnvParams`, lines 20–26)
- Modify: `packages/shared/src/engines/synth2.test.ts` (append test)

**Interfaces:**
- Consumes: existing `LFO_SYNC_DIVISIONS`, `LFO_SYNC_LABELS`, `LFO_SYNC_DEFAULT_INDEX` from `lfo-sync.ts`.
- Produces (used by Tasks 2–3): `divisionToSeconds(label: string, bpm: number): number` exported from `@fiddle/shared`; `Synth2EnvParams` gains `sync: boolean; aDiv: string; dDiv: string; rDiv: string`; `DEFAULT_SYNTH2_PARAMS.env{1,2,3}` gain `sync: false, aDiv: '1/32', dDiv: '1/8', rDiv: '1/4'` (derived via `buildDefaults`).

- [ ] **Step 1: Write the failing `divisionToSeconds` tests**

Append to `packages/shared/src/engines/lfo-sync.test.ts` (add `divisionToSeconds` to the existing import from `./lfo-sync.js`):

```ts
describe('divisionToSeconds', () => {
  it('derives seconds = (60 * beats) / bpm at 120 BPM', () => {
    expect(divisionToSeconds('1/4', 120)).toBeCloseTo(0.5, 10);    // 1 beat
    expect(divisionToSeconds('1/8', 120)).toBeCloseTo(0.25, 10);   // 0.5 beat
    expect(divisionToSeconds('1/32', 120)).toBeCloseTo(0.0625, 10);
  });

  it('spans 20.8ms (1/32T @ 240) to 9s (1/1. @ 40) across the BPM range', () => {
    expect(divisionToSeconds('1/32T', 240)).toBeCloseTo((60 * (1 / 12)) / 240, 10);
    expect(divisionToSeconds('1/1.', 40)).toBeCloseTo(9, 10);
  });

  it('is the reciprocal of divisionToHz for every division', () => {
    for (const d of LFO_SYNC_DIVISIONS) {
      expect(divisionToSeconds(d.label, 97)).toBeCloseTo(1 / divisionToHz(d.label, 97), 10);
    }
  });

  it('falls back to the default division for an unknown label (never NaN)', () => {
    expect(divisionToSeconds('nope', 120)).toBeCloseTo(divisionToSeconds('1/16', 120), 10);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm -w @fiddle/shared test -- lfo-sync`
Expected: FAIL — `divisionToSeconds` is not exported.

- [ ] **Step 3: Implement `divisionToSeconds`**

Append to `packages/shared/src/engines/lfo-sync.ts`:

```ts
/** Note-division label + BPM → duration in seconds (envelope tempo-sync,
 *  spec 2026-07-06). Reciprocal of divisionToHz; same unknown-label fallback
 *  so a corrupt/old value can never yield NaN. */
export function divisionToSeconds(label: string, bpm: number): number {
  const entry = LFO_SYNC_DIVISIONS.find(d => d.label === label)
    ?? LFO_SYNC_DIVISIONS[LFO_SYNC_DEFAULT_INDEX];
  return (60 * entry.beats) / bpm;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npm -w @fiddle/shared test -- lfo-sync`
Expected: PASS (all lfo-sync tests).

- [ ] **Step 5: Write the failing descriptor + defaults tests**

In `packages/shared/src/engines/synth2-descriptors.test.ts`:

(a) Extend `DISCRETE_KEYS` (line 9) — append after `'lfo2.div'`:

```ts
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'env1.loop', 'env2.loop', 'env3.loop', 'filter.model', 'lfo1.sync', 'lfo1.div', 'lfo2.sync', 'lfo2.div', 'env1.sync', 'env1.aDiv', 'env1.dDiv', 'env1.rDiv', 'env2.sync', 'env2.aDiv', 'env2.dDiv', 'env2.rDiv', 'env3.sync', 'env3.aDiv', 'env3.dDiv', 'env3.rDiv'];
```

(b) In the tail-order key-list test (~line 54), append after `'lfo1.sync', 'lfo1.div', 'lfo2.sync', 'lfo2.div',`:

```ts
      'env1.sync', 'env1.aDiv', 'env1.dDiv', 'env1.rDiv',
      'env2.sync', 'env2.aDiv', 'env2.dDiv', 'env2.rDiv',
      'env3.sync', 'env3.aDiv', 'env3.dDiv', 'env3.rDiv',
```

(c) Add a new test inside the existing top-level describe. If the file does not already import `LFO_SYNC_LABELS`, add `import { LFO_SYNC_LABELS } from './lfo-sync.js';`:

```ts
  it('envelope tempo-sync rows: bool + three LFO_SYNC_LABELS enums per envelope, defaults 1/32 / 1/8 / 1/4 (2026-07-06)', () => {
    for (const env of ['env1', 'env2', 'env3']) {
      const sync = SYNTH2_DESCRIPTORS.find(d => d.key === `${env}.sync`)!;
      expect(sync.kind, sync.key).toBe('bool');
      expect(sync.default, sync.key).toBe(0); // off
      expect(sync.modulatable, sync.key).toBe(false);
      const stageDefaults = { aDiv: '1/32', dDiv: '1/8', rDiv: '1/4' } as const;
      for (const [field, label] of Object.entries(stageDefaults)) {
        const d = SYNTH2_DESCRIPTORS.find(x => x.key === `${env}.${field}`)!;
        expect(d.kind, d.key).toBe('enum');
        expect(d.enumValues, d.key).toBe(LFO_SYNC_LABELS);
        expect(d.min, d.key).toBe(0);
        expect(d.max, d.key).toBe(LFO_SYNC_LABELS.length - 1);
        expect(d.default, d.key).toBe(LFO_SYNC_LABELS.indexOf(label));
        expect(d.modulatable, d.key).toBe(false);
      }
    }
  });
```

In `packages/shared/src/engines/synth2.test.ts`, append inside the `DEFAULT_SYNTH2_PARAMS` describe:

```ts
  it('defaults each envelope tempo-sync off with 1/32 / 1/8 / 1/4 divisions (2026-07-06)', () => {
    for (const env of [DEFAULT_SYNTH2_PARAMS.env1, DEFAULT_SYNTH2_PARAMS.env2, DEFAULT_SYNTH2_PARAMS.env3]) {
      expect(env.sync).toBe(false);
      expect(env.aDiv).toBe('1/32');
      expect(env.dDiv).toBe('1/8');
      expect(env.rDiv).toBe('1/4');
    }
  });
```

- [ ] **Step 6: Run to verify failure**

Run: `npm -w @fiddle/shared test -- synth2-descriptors synth2.test`
Expected: FAIL — new keys missing from the table (tail-order + new tests fail; `env.sync` etc. undefined).

- [ ] **Step 7: Append the 12 descriptor rows**

In `packages/shared/src/engines/synth2-descriptors.ts`, append after the `lfo2.div` row (before the closing `];` of `SYNTH2_DESCRIPTORS`):

```ts
  // --- Envelope tempo-sync (2026-07-06, append-only). Opt-in per ENVELOPE:
  // one sync toggle switches that envelope's A/D/R to note divisions (each
  // stage keeps its own division). Derived SECONDS are computed on the MAIN
  // THREAD (AudioEngine, divisionToSeconds) and written into env*.a/d/r before
  // reaching the kernel — these 12 rows are dead block slots exactly like
  // lfo*.sync/div, kept so the leaves auto-derive (schema/accept-list/defaults).
  // Per-stage defaults ≈ the free-mode defaults at 120 BPM (62ms/250ms/500ms).
  { key: 'env1.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env1.aDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/32'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env1.dDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/8'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env1.rDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/4'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env2.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env2.aDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/32'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env2.dDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/8'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env2.rDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/4'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env3.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'env3.aDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/32'), taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env3.dDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/8'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'env3.rDiv', min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_LABELS.indexOf('1/4'),  taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
```

- [ ] **Step 8: Extend `Synth2EnvParams`**

In `packages/shared/src/engines/synth2.ts`, replace the interface (lines 20–26):

```ts
export interface Synth2EnvParams {
  a: number;      // seconds — free-mode time; when sync is on the kernel receives
                  // a main-thread-derived duration instead (this leaf is never overwritten)
  d: number;
  s: number;
  r: number;
  loop: boolean; // I3c: cycle attack→decay→attack while gated (shared by env1/env2/env3)
  sync: boolean;  // tempo-sync on/off (a/d/r derived from divs × bpm on the main thread)
  aDiv: string;   // note-division labels from LFO_SYNC_DIVISIONS (used when sync is on)
  dDiv: string;
  rDiv: string;
}
```

No `buildDefaults` change needed — the new rows decode via the existing `decodeBool`/`decodeEnum` branches.

- [ ] **Step 9: Run to verify pass**

Run: `npm -w @fiddle/shared test -- synth2-descriptors synth2.test`
Expected: PASS.

- [ ] **Step 10: Full shared gate**

Run: `npm -w @fiddle/shared test && npm -w @fiddle/shared run typecheck`
Expected: all shared tests pass (215 before this task; more now), `tsc --noEmit` clean. If any other shared test asserts the full descriptor key set/count, extend it with the 12 new keys in the same append order.

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/engines/lfo-sync.ts packages/shared/src/engines/lfo-sync.test.ts packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): envelope tempo-sync divisions — divisionToSeconds + 12 descriptor rows"
```

---

### Task 2: AudioEngine — `effectiveEnvTimes` derivation at build / env-leaf / bpm sites

**Files:**
- Modify: `packages/client/src/audio/AudioEngine.ts` (helper ~line 79; build site ~line 218; bpm branch ~line 269; leaf branch ~line 305)
- Modify: `packages/client/src/audio/AudioEngine.test.ts` (append describe block)

**Interfaces:**
- Consumes (Task 1): `divisionToSeconds` from `@fiddle/shared`; `DEFAULT_SYNTH2_PARAMS.env*` now carry `sync:false, aDiv:'1/32', dDiv:'1/8', rDiv:'1/4'`.
- Produces: module-private `effectiveEnvTimes(env, bpm): { a: number; d: number; r: number }` — no exports change; behavior only.

- [ ] **Step 1: Write the failing derivation tests**

Append to `packages/client/src/audio/AudioEngine.test.ts` (mirrors the existing `AudioEngine — LFO tempo-sync rate derivation` block and reuses its `makeEngine` helper):

```ts
describe('AudioEngine — envelope tempo-sync time derivation', () => {
  async function synth2EnvEngine(env1: Partial<{ sync: boolean; aDiv: string; dDiv: string; rDiv: string; a: number; d: number; r: number }>) {
    const h = makeEngine();
    h.project.bpm = 120;
    h.project.tracks[0].engineType = 'synth2';
    Object.assign(h.project.tracks[0].engines.synth2.env1, env1);
    const state = await h.engine.ensureAudio();
    const spy = vi.spyOn(state.engines[0]!, 'applyParams');
    spy.mockClear();
    return { ...h, state, spy };
  }

  it('re-pushes derived A/D/R seconds to a synced envelope on BPM change', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true }); // divs at defaults 1/32, 1/8, 1/4
    set(['bpm'], 120);
    // @120: 1/32 = 62.5ms, 1/8 = 250ms, 1/4 = 500ms
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 0.0625, d: 0.25, r: 0.5 }) });
  });

  it('does NOT re-push a free-mode envelope on BPM change', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: false });
    set(['bpm'], 120);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives times when a synced envelope div changes', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'dDiv'], '1/4'); // 1 beat @120 → 0.5s
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.5 }) });
  });

  it('derives times when SYNC is turned on', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'sync'], true);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ a: 0.0625, d: 0.25, r: 0.5 }) });
  });

  it('passes raw seconds through for a free-mode a/d/r edit', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'd'], 1.5);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 1.5 }) });
  });

  it('a raw a/d/r write on a SYNCED envelope still reaches audio derived (leaf preserved, derived wins)', async () => {
    const { set, spy, project } = await synth2EnvEngine({ sync: true });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 'd'], 5);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ d: 0.25 }) }); // derived, not 5
    expect(project.tracks[0].engines.synth2.env1.d).toBe(5); // persisted leaf untouched
  });

  it('sustain and loop ride through unchanged when synced', async () => {
    const { set, spy } = await synth2EnvEngine({ sync: true, dDiv: '1/8' });
    set(['tracks', 0, 'engines', 'synth2', 'env1', 's'], 0.7);
    expect(spy).toHaveBeenCalledWith({ env1: expect.objectContaining({ s: 0.7, d: 0.25 }) });
  });
});
```

Note: if `makeEngine`'s returned handle does not already expose `project`, destructure it the same way the neighboring LFO block does — read the fixture first and reuse its exact helper names.

- [ ] **Step 2: Run to verify failure**

Run: `npm -w @fiddle/client test -- AudioEngine`
Expected: FAIL — env changes reach `applyParams` with raw leaf values (no derivation), and BPM changes don't re-push envelopes.

- [ ] **Step 3: Implement `effectiveEnvTimes` + wire the three sites**

In `packages/client/src/audio/AudioEngine.ts`:

(a) Extend the shared import (line 2):

```ts
import { TRACK_POOL_SIZE, divisionToHz, divisionToSeconds, LFO_SYNC_DEFAULT_LABEL } from '@fiddle/shared';
```

(b) Add below `effectiveLfoRate` (~line 79):

```ts
// A synced envelope's A/D/R times are derived on the main thread from its note
// divisions and the project BPM (the kernel is tempo-agnostic); a free envelope
// uses its stored seconds. The clamp is defensive: within BPM 40–240 the
// derived range is 20.8ms–9s, already inside the descriptor's [0.001, 10].
function effectiveEnvTimes(
  env: { sync?: boolean; aDiv?: string; dDiv?: string; rDiv?: string; a: number; d: number; r: number },
  bpm: number,
): { a: number; d: number; r: number } {
  if (!env.sync) return { a: env.a, d: env.d, r: env.r };
  const t = (label: string | undefined) =>
    Math.min(10, Math.max(0.001, divisionToSeconds(label ?? LFO_SYNC_DEFAULT_LABEL, bpm)));
  return { a: t(env.aDiv), d: t(env.dDiv), r: t(env.rDiv) };
}
```

(c) Build site — replace the synth2 branch of `syncTrackToEngine` (~lines 218–225):

```ts
      const params = track.engines[targetType] as Record<string, any>;
      if (targetType === 'synth2') {
        const s2 = params as unknown as { lfo1: any; lfo2: any; env1: any; env2: any; env3: any };
        engines[i]!.applyParams({
          ...params,
          lfo1: { ...s2.lfo1, rate: effectiveLfoRate(s2.lfo1, project.bpm) },
          lfo2: { ...s2.lfo2, rate: effectiveLfoRate(s2.lfo2, project.bpm) },
          env1: { ...s2.env1, ...effectiveEnvTimes(s2.env1, project.bpm) },
          env2: { ...s2.env2, ...effectiveEnvTimes(s2.env2, project.bpm) },
          env3: { ...s2.env3, ...effectiveEnvTimes(s2.env3, project.bpm) },
        });
      } else {
        engines[i]!.applyParams(params);
      }
```

(d) BPM branch — extend the existing `if (p[0] === 'bpm')` loop body (after the `lfo1`/`lfo2` loop, inside the same per-track loop):

```ts
          for (const key of ['env1', 'env2', 'env3'] as const) {
            const env = project.tracks[i].engines.synth2[key];
            if (!env.sync) continue;
            engine.applyParams({ [key]: { ...snapshot(env), ...effectiveEnvTimes(env, project.bpm) } });
          }
```

(e) Leaf branch — after the existing `lfo1`/`lfo2` interception inside `case 'engines'`, add:

```ts
          if (slice === 'synth2' && (key === 'env1' || key === 'env2' || key === 'env3')) {
            const env = liveSlice[key] as { sync?: boolean; aDiv?: string; dDiv?: string; rDiv?: string; a: number; d: number; r: number };
            engine.applyParams({ [key]: { ...snapshot(env), ...effectiveEnvTimes(env, project.bpm) } });
            return;
          }
```

- [ ] **Step 4: Run to verify pass**

Run: `npm -w @fiddle/client test -- AudioEngine`
Expected: PASS (new block + all existing AudioEngine tests, including the LFO derivation block).

- [ ] **Step 5: Full client gate**

Run: `npm -w @fiddle/client test && npm -w @fiddle/client run typecheck`
Expected: all client tests pass, `vue-tsc --noEmit` clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts
git commit -m "feat(client): derive synced envelope A/D/R seconds main-thread in AudioEngine"
```

---

### Task 3: Synth2Panel — per-envelope SYNC button + conditional A/D/R division knobs

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue` (env1 block ~lines 36–45; env2 ~lines 138–149; env3 ~lines 152–163; style ~lines 267–287)
- Modify: `packages/client/src/components/Synth2Panel.test.ts` (append describe block)

**Interfaces:**
- Consumes (Task 1): `params.env{1,2,3}.sync/aDiv/dDiv/rDiv` (typed via `Synth2EnvParams`); `LFO_SYNC_LABELS`, `divisionLabelToIndex` (already imported in the component); `DEFAULTS.env*.aDiv/dDiv/rDiv` (from `Synth2Engine.DEFAULT_PARAMS`).
- Produces: 3 × `.env-sync-btn` buttons; synced A/D/R knobs dispatch division labels via `ks.set(['envN', 'aDiv'|'dDiv'|'rDiv'], LFO_SYNC_LABELS[$event])`.

- [ ] **Step 1: Write the failing panel tests**

Append to `packages/client/src/components/Synth2Panel.test.ts`:

```ts
describe('Synth2Panel envelope tempo-sync', () => {
  it('renders one SYNC toggle per envelope, distinct from LFO and osc sync buttons', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.querySelectorAll<HTMLButtonElement>('.env-sync-btn').length).toBe(3);
    expect(el.querySelectorAll<HTMLButtonElement>('.lfo-sync-btn').length).toBe(2); // unchanged
    expect(el.querySelectorAll<HTMLButtonElement>('.sync-btn').length).toBe(2);     // unchanged
  });

  it('dispatches env1.sync toggled true on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btn = el.querySelectorAll<HTMLButtonElement>('.env-sync-btn')[0];
    expect(params.env1.sync).toBe(false);
    btn.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('env1', 'sync'), true);
  });

  it('shows division labels on A/D/R when synced while S stays a percent knob', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.sync = true;
    params.env1.aDiv = '1/1T';  // distinctive labels that appear nowhere else
    params.env1.dDiv = '1/2.';
    params.env1.rDiv = '1/16T';
    const el = mountPanel(params);
    expect(el.textContent).toContain('1/1T');
    expect(el.textContent).toContain('1/2.');
    expect(el.textContent).toContain('1/16T');
    expect(el.textContent).toContain('50%'); // env1.s default 0.5 still renders as percent
  });

  it('free mode still shows time readouts (no division labels)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.textContent).not.toContain('1/32'); // aDiv default hidden while free
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm -w @fiddle/client test -- Synth2Panel`
Expected: FAIL — no `.env-sync-btn` elements.

- [ ] **Step 3: Implement the template + style changes**

In `packages/client/src/components/Synth2Panel.vue`:

(a) Replace the **AMP ENV** (env1) module-group (~lines 36–45) with:

```html
      <div class="module-group">
        <h3>AMP ENV</h3>
        <div class="knob-row">
          <Knob v-if="!params.env1.sync" label="A" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env1.a" :modelValue="params.env1.a" @update:modelValue="ks.set(['env1', 'a'], $event)" :syncPath="ks.pathFor(['env1', 'a'])" @gesture-end="ks.end(['env1', 'a'])" />
          <Knob v-else label="A" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.env1.aDiv)" :modelValue="divisionLabelToIndex(params.env1.aDiv)" @update:modelValue="ks.set(['env1', 'aDiv'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'aDiv'])" @gesture-end="ks.end(['env1', 'aDiv'])" />
          <Knob v-if="!params.env1.sync" label="D" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env1.d" :modelValue="params.env1.d" @update:modelValue="ks.set(['env1', 'd'], $event)" :syncPath="ks.pathFor(['env1', 'd'])" @gesture-end="ks.end(['env1', 'd'])" />
          <Knob v-else label="D" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.env1.dDiv)" :modelValue="divisionLabelToIndex(params.env1.dDiv)" @update:modelValue="ks.set(['env1', 'dDiv'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'dDiv'])" @gesture-end="ks.end(['env1', 'dDiv'])" />
          <Knob label="S" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env1.s" :modelValue="params.env1.s" @update:modelValue="ks.set(['env1', 's'], $event)" :syncPath="ks.pathFor(['env1', 's'])" @gesture-end="ks.end(['env1', 's'])" />
          <Knob v-if="!params.env1.sync" label="R" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env1.r" :modelValue="params.env1.r" @update:modelValue="ks.set(['env1', 'r'], $event)" :syncPath="ks.pathFor(['env1', 'r'])" @gesture-end="ks.end(['env1', 'r'])" />
          <Knob v-else label="R" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.env1.rDiv)" :modelValue="divisionLabelToIndex(params.env1.rDiv)" @update:modelValue="ks.set(['env1', 'rDiv'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'rDiv'])" @gesture-end="ks.end(['env1', 'rDiv'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env1.loop }" @click="ks.set(['env1', 'loop'], !params.env1.loop)">LOOP</button>
        <button type="button" class="env-sync-btn" :class="{ active: params.env1.sync }" @click="ks.set(['env1', 'sync'], !params.env1.sync)">SYNC</button>
      </div>
```

(b) Apply the **identical transformation** to the env2 block (Column 6, ~lines 138–149) and the env3 block (Column 7, ~lines 152–163): every occurrence of `env1` in the block above becomes `env2` / `env3` respectively; the surrounding `<h3>` headings and comments stay as they are in the file. Do not touch the S knob or LOOP button beyond what's shown (S never becomes conditional; LOOP keeps its line; SYNC is added after LOOP).

(c) Style — extend the three `.lfo-sync-btn` selectors (~lines 267–287) to cover the new class (shared source of truth, no copied block):

```css
.lfo-sync-btn,
.env-sync-btn {
  /* existing .lfo-sync-btn declarations unchanged */
}
```

and the same comma-extension for `.lfo-sync-btn:hover { ... }` → `.lfo-sync-btn:hover, .env-sync-btn:hover { ... }` and `.lfo-sync-btn.active { ... }` → `.lfo-sync-btn.active, .env-sync-btn.active { ... }`.

- [ ] **Step 4: Run to verify pass**

Run: `npm -w @fiddle/client test -- Synth2Panel`
Expected: PASS — new block green; existing hard-sync (`.sync-btn` count 2), LFO tempo-sync (`.lfo-sync-btn` count 2), and envelope-loop tests all still green.

- [ ] **Step 5: Full client gate + build**

Run: `npm -w @fiddle/client test && npm -w @fiddle/client run build`
Expected: all client tests pass; `vue-tsc` + vite build clean.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): per-envelope SYNC button + division A/D/R knobs in Synth2Panel"
```

---

## Whole-Branch Verification (controller, after all tasks)

- [ ] Full gate: `npm -w @fiddle/shared test && npm -w @fiddle/shared run typecheck && npm -w @fiddle/client test && npm -w @fiddle/client run build && npm -w @fiddle/server test`
  Expected: everything green (pre-branch baseline: shared 215 / client 742 / server 174 + 13 skipped).
- [ ] **Browser verification (MANDATORY, `npm run dev:obs` — never `npm run dev`):** on a NEW throwaway session, with a synth2 track focused, read the LIVE worklet param block + store + DOM:
  1. Defaults flow through: live project `tracks[0].engines.synth2.env1` = `{..., sync: false, aDiv: '1/32', dDiv: '1/8', rDiv: '1/4'}`; 12 new block slots present at the end of the descriptor region.
  2. Derivation: env1 SYNC on @ 120 BPM → block `env1.d` slot = 0.25 (1/8) while the store leaf `env1.d` keeps its free value; `env1.a` = 0.0625, `env1.r` = 0.5.
  3. BPM tracking: 120 → 60 → block `env1.d` = 0.5. SYNC off → block returns to the free seconds.
  4. UI: 3 `.env-sync-btn` render (LFO SYNC still 2, osc SYNC still 2); synced A/D/R readouts show division labels; S still percent; LOOP unaffected; audible envelope change on toggle.
  5. Console clean (pre-existing favicon 404 acceptable). Close the browser session/tab when done.
- [ ] Known limitation to note in the final report (not to fix): the 12 new leaves hit the synth2 old-session sync gap — old saved sessions won't sync them until re-saved (open backlog item: param-level deep-merge in `packages/shared/src/project/normalize.ts` `repairTrack`).
