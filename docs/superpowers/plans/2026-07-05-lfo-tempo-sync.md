# LFO Tempo-Sync + Sub-Hz Rate Display (synth2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional per-LFO tempo-synced mode (note divisions locked to project BPM) to the synth2 engine, and fix the LFO Rate knob's sub-1 Hz "dead zone" so slow rates display with decimals.

**Architecture:** The kernel stays tempo-agnostic. Two new persisted leaves per LFO (`sync` bool, `div` enum-label) ride the append-only descriptor block but are *not read by the kernel*; when `sync` is on, `AudioEngine` (which already owns `project.bpm` and is the sole worklet-param writer) derives the effective Hz from `div × bpm` on the main thread and writes it into `lfoN.rate` before it reaches the worklet. The persisted `lfoN.rate` leaf (free-mode Hz) is never overwritten. The panel's existing Rate knob binds conditionally: free → Hz, synced → the division index. Part A is an independent presentational change to the shared knob value formatter.

**Tech Stack:** TypeScript monorepo (`@fiddle/shared`, `@fiddle/server`, `@fiddle/client`), Zod, Vue 3.5 (`<script setup>`), Pinia, Vitest, Web Audio AudioWorklet.

## Global Constraints

- **Branch:** work on `feat/lfo-tempo-sync` (already checked out). NEVER commit on `main`.
- **Descriptor rows APPEND at the END** of `SYNTH2_DESCRIPTORS` (after `filter.drive`). The block index is the array position — never insert or reorder existing rows.
- **Kernel stays tempo-agnostic.** The derived Hz is computed on the main thread in `AudioEngine`. The kernel never reads `lfo*.sync` / `lfo*.div`.
- **`lfo*.rate` (the existing Hz leaf) is never overwritten** — it stays the free-mode value and the restore target when SYNC is toggled off.
- **`lfo*.div` persists as the division LABEL STRING** (e.g. `"1/16"`); the numeric index only exists in the kernel block via `encodeEnum`/`decodeEnum`. Same convention as `filter.type`.
- **Division set = 18 entries**, index = wire encoding, ordered slowest→fastest, default `1/16`. `Hz = bpm / (60 × beatsPerCycle)`; dotted `.` = ×1.5 duration, triplet `T` = ×2/3.
- **New descriptor rows:** `kind` `bool`/`enum`, `taper:'linear'`, `modulatable:false`, `modScale:0` (not mod destinations).
- **Part A hz formatter:** show decimals only when `val < 10`; `10 ≤ val < 1000` and `val ≥ 1000` branches unchanged.
- **Staging:** `git add` ONLY the exact files each step names. NEVER `git add -A`/`-u`. NEVER stage `studio-focused.md`, `studio-initial.png`, `synth2-wave-previews.png` (untracked scratch in the repo root).
- **Commit trailer:** end every commit message with these two lines:
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DFmmWXyd9uJAiJ6cdbE4ir
  ```
- **Testing:** TDD (failing test first). Run the focused test while iterating; run the workspace suite once before committing. NEVER run `npm run dev` (it reads the real prod Supabase). Local runtime testing is `npm run dev:obs` only, reserved for the post-plan browser verification.
- **Known limitation (do NOT fix):** sessions saved before this change won't sync the 4 new leaves until re-saved (the recurring slice-level server-normalize gap). New sessions and local defaults are fine.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/shared/src/engines/lfo-sync.ts` (new) | Single source of truth for the division table (`LFO_SYNC_DIVISIONS`, labels, default index) and the pure `divisionToHz` / `divisionLabelToIndex` helpers. |
| `packages/shared/src/engines/synth2-descriptors.ts` | Append the 4 `lfo*.sync`/`lfo*.div` descriptor rows (imports the division constants). |
| `packages/shared/src/engines/synth2.ts` | Extend `Synth2LfoParams` with `sync`/`div`. |
| `packages/client/src/ui/knobFormat.ts` (new) | Pure `formatKnobValue(format, value, labels?)` — the value-label logic extracted out of `Knob.vue`, plus the hz-decimals (Part A) and `labels` behaviours. |
| `packages/client/src/components/Knob.vue` | Add optional `labels` prop; delegate the readout to `formatKnobValue`. |
| `packages/client/src/audio/AudioEngine.ts` | Derive the effective LFO Hz (build path + leaf-edit path + new bpm path). |
| `packages/client/src/components/Synth2Panel.vue` | Per-LFO SYNC button + conditional Rate-knob binding + div index↔label wiring (inline). |

---

## Task 1: Shared data model — division table + descriptor rows

**Files:**
- Create: `packages/shared/src/engines/lfo-sync.ts`
- Create: `packages/shared/src/engines/lfo-sync.test.ts`
- Modify: `packages/shared/src/engines/index.ts` (barrel export)
- Modify: `packages/shared/src/engines/synth2-descriptors.ts` (append 4 rows)
- Modify: `packages/shared/src/engines/synth2.ts` (`Synth2LfoParams` type)
- Modify: `packages/shared/src/engines/synth2-descriptors.test.ts` (fixtures)
- Modify: `packages/shared/src/engines/synth2.test.ts` (default fixtures)

**Interfaces:**
- Produces (consumed by Tasks 3 & 4):
  - `LFO_SYNC_DIVISIONS: readonly { label: string; beats: number }[]` (18 entries)
  - `LFO_SYNC_LABELS: readonly string[]` — `LFO_SYNC_DIVISIONS.map(d => d.label)`
  - `LFO_SYNC_DEFAULT_LABEL = '1/16'`, `LFO_SYNC_DEFAULT_INDEX = 13`
  - `divisionToHz(label: string, bpm: number): number`
  - `divisionLabelToIndex(label: string): number`
  - `Synth2LfoParams` now has `sync: boolean; div: string`.

- [ ] **Step 1: Write the failing test for the division table + helpers**

Create `packages/shared/src/engines/lfo-sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  LFO_SYNC_DIVISIONS, LFO_SYNC_LABELS, LFO_SYNC_DEFAULT_LABEL,
  LFO_SYNC_DEFAULT_INDEX, divisionToHz, divisionLabelToIndex,
} from './lfo-sync.js';

describe('LFO_SYNC_DIVISIONS', () => {
  it('has 18 entries with unique labels', () => {
    expect(LFO_SYNC_DIVISIONS).toHaveLength(18);
    expect(new Set(LFO_SYNC_LABELS).size).toBe(18);
  });

  it('is ordered slowest → fastest (strictly descending beats-per-cycle)', () => {
    for (let i = 1; i < LFO_SYNC_DIVISIONS.length; i++) {
      expect(LFO_SYNC_DIVISIONS[i].beats).toBeLessThan(LFO_SYNC_DIVISIONS[i - 1].beats);
    }
  });

  it('defaults to 1/16 at index 13', () => {
    expect(LFO_SYNC_DEFAULT_LABEL).toBe('1/16');
    expect(LFO_SYNC_DEFAULT_INDEX).toBe(13);
    expect(LFO_SYNC_LABELS[13]).toBe('1/16');
  });
});

describe('divisionToHz', () => {
  it('derives Hz = bpm / (60 * beats) at 120 BPM', () => {
    expect(divisionToHz('1/4', 120)).toBeCloseTo(2, 6);      // 1 beat/cycle
    expect(divisionToHz('1/16', 120)).toBeCloseTo(8, 6);     // 0.25 beat/cycle
    expect(divisionToHz('1/1', 120)).toBeCloseTo(0.5, 6);    // 4 beats/cycle
    expect(divisionToHz('1/1.', 120)).toBeCloseTo(1 / 3, 6); // 6 beats/cycle
    expect(divisionToHz('1/32T', 120)).toBeCloseTo(24, 6);   // 1/12 beat/cycle
  });

  it('scales with BPM', () => {
    expect(divisionToHz('1/4', 60)).toBeCloseTo(1, 6);
    expect(divisionToHz('1/4', 140)).toBeCloseTo(140 / 60, 6);
  });

  it('falls back to the default division for an unknown label (never NaN)', () => {
    expect(divisionToHz('bogus', 120)).toBe(divisionToHz('1/16', 120));
    expect(Number.isNaN(divisionToHz('bogus', 120))).toBe(false);
  });
});

describe('divisionLabelToIndex', () => {
  it('maps a known label to its index', () => {
    expect(divisionLabelToIndex('1/16')).toBe(13);
    expect(divisionLabelToIndex('1/1.')).toBe(0);
    expect(divisionLabelToIndex('1/32T')).toBe(17);
  });
  it('maps an unknown label to the default index', () => {
    expect(divisionLabelToIndex('bogus')).toBe(LFO_SYNC_DEFAULT_INDEX);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm -w @fiddle/shared test -- lfo-sync`
Expected: FAIL — cannot resolve `./lfo-sync.js`.

- [ ] **Step 3: Create `packages/shared/src/engines/lfo-sync.ts`**

```ts
// Single source of truth for LFO tempo-sync note divisions (spec
// 2026-07-05-lfo-tempo-sync-design.md). Consumed by the synth2 descriptor table
// (enum values), AudioEngine (rate derivation), and Synth2Panel (knob labels).
// The index is the wire encoding for the `lfo*.div` enum and is append-stable.

export interface LfoSyncDivision {
  /** Display label, also the persisted enum value (e.g. "1/16", "1/8.", "1/4T"). */
  readonly label: string;
  /** Beats per LFO cycle, quarter-note = 1 beat. Dotted = ×1.5, triplet = ×2/3. */
  readonly beats: number;
}

// Ordered slowest → fastest so the knob sweeps left(slow)→right(fast), matching
// the free-mode Hz knob's direction.
export const LFO_SYNC_DIVISIONS: readonly LfoSyncDivision[] = [
  { label: '1/1.',  beats: 6 },
  { label: '1/1',   beats: 4 },
  { label: '1/2.',  beats: 3 },
  { label: '1/1T',  beats: 8 / 3 },
  { label: '1/2',   beats: 2 },
  { label: '1/4.',  beats: 1.5 },
  { label: '1/2T',  beats: 4 / 3 },
  { label: '1/4',   beats: 1 },
  { label: '1/8.',  beats: 0.75 },
  { label: '1/4T',  beats: 2 / 3 },
  { label: '1/8',   beats: 0.5 },
  { label: '1/16.', beats: 0.375 },
  { label: '1/8T',  beats: 1 / 3 },
  { label: '1/16',  beats: 0.25 },
  { label: '1/32.', beats: 0.1875 },
  { label: '1/16T', beats: 1 / 6 },
  { label: '1/32',  beats: 0.125 },
  { label: '1/32T', beats: 1 / 12 },
];

export const LFO_SYNC_LABELS: readonly string[] = LFO_SYNC_DIVISIONS.map(d => d.label);
export const LFO_SYNC_DEFAULT_LABEL = '1/16';
export const LFO_SYNC_DEFAULT_INDEX = LFO_SYNC_LABELS.indexOf(LFO_SYNC_DEFAULT_LABEL);

/** Note-division label + BPM → LFO frequency in Hz. Unknown label falls back to
 *  the default division, so a corrupt/old value can never yield NaN. */
export function divisionToHz(label: string, bpm: number): number {
  const entry = LFO_SYNC_DIVISIONS.find(d => d.label === label)
    ?? LFO_SYNC_DIVISIONS[LFO_SYNC_DEFAULT_INDEX];
  return bpm / (60 * entry.beats);
}

/** Division label → its index; unknown label → the default index. */
export function divisionLabelToIndex(label: string): number {
  const i = LFO_SYNC_LABELS.indexOf(label);
  return i < 0 ? LFO_SYNC_DEFAULT_INDEX : i;
}
```

- [ ] **Step 4: Export from the engines barrel**

In `packages/shared/src/engines/index.ts`, add a line alongside the other exports (put it just before `./synth2-descriptors.js` so the descriptor file's import resolves cleanly):

```ts
export * from './lfo-sync.js';
```

- [ ] **Step 5: Run the division test to confirm it passes**

Run: `npm -w @fiddle/shared test -- lfo-sync`
Expected: PASS (all cases).

- [ ] **Step 6: Extend the `Synth2LfoParams` type**

In `packages/shared/src/engines/synth2.ts`, the interface currently is:

```ts
export interface Synth2LfoParams {
  rate: number;   // Hz
  shape: number;  // 0..4 morph: sine → tri → saw-up → saw-down → square
}
```

Replace it with:

```ts
export interface Synth2LfoParams {
  rate: number;   // Hz — free-mode rate; when sync is on the kernel receives a
                  // main-thread-derived Hz instead (this leaf is never overwritten)
  shape: number;  // 0..4 morph: sine → tri → saw-up → saw-down → square
  sync: boolean;  // tempo-sync on/off (rate derived from div × bpm on the main thread)
  div: string;    // note-division label from LFO_SYNC_DIVISIONS (used when sync is on)
}
```

- [ ] **Step 7: Update the descriptor-table fixtures (RED first)**

In `packages/shared/src/engines/synth2-descriptors.test.ts`:

(a) Append the 4 keys to `DISCRETE_KEYS` (line ~8):

```ts
const DISCRETE_KEYS = ['osc1.sync', 'osc2.sync', 'osc3.sync', 'filter.type', 'env1.loop', 'env2.loop', 'env3.loop', 'filter.model', 'lfo1.sync', 'lfo1.div', 'lfo2.sync', 'lfo2.div'];
```

(b) In the `'covers exactly the I3d param set (append-only from here)'` test, append the 4 keys to the very end of the `toEqual([...])` array, right after `'filter.drive',`:

```ts
      'filter.drive',
      'lfo1.sync', 'lfo1.div', 'lfo2.sync', 'lfo2.div',
    ]);
```

In `packages/shared/src/engines/synth2.test.ts`, update the two LFO default assertions (lines ~63-64):

```ts
    expect(DEFAULT_SYNTH2_PARAMS.lfo1).toEqual({ rate: 5, shape: 0, sync: false, div: '1/16' });
    expect(DEFAULT_SYNTH2_PARAMS.lfo2).toEqual({ rate: 0.5, shape: 1, sync: false, div: '1/16' });
```

- [ ] **Step 8: Run the shared suite to confirm these now FAIL (rows not appended yet)**

Run: `npm -w @fiddle/shared test -- synth2-descriptors synth2.test`
Expected: FAIL — the descriptor key list and the default LFO objects don't yet include the new rows.

- [ ] **Step 9: Append the 4 descriptor rows**

In `packages/shared/src/engines/synth2-descriptors.ts`:

Add the import near the top (after the `KnobCurve` import):

```ts
import { LFO_SYNC_LABELS, LFO_SYNC_DEFAULT_INDEX } from './lfo-sync.js';
```

Append these rows at the **very end** of the `SYNTH2_DESCRIPTORS` array, immediately after the `filter.drive` row:

```ts
  // --- LFO tempo-sync (2026-07-05, append-only). Opt-in per LFO. When sync is
  // on, the effective rate is derived on the MAIN THREAD (AudioEngine) from the
  // note division × project bpm and written into lfoN.rate before it reaches the
  // kernel — the kernel never reads these two rows, so they are dead block slots
  // kept only so the leaves auto-derive (schema / accept-list / defaults). Not
  // mod dests (modulatable:false, modScale:0), like osc sync bools / filter enums.
  { key: 'lfo1.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'lfo1.div',  min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_DEFAULT_INDEX, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
  { key: 'lfo2.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool' },
  { key: 'lfo2.div',  min: 0, max: LFO_SYNC_LABELS.length - 1, default: LFO_SYNC_DEFAULT_INDEX, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: LFO_SYNC_LABELS },
```

- [ ] **Step 10: Run the full shared suite + typecheck**

Run: `npm -w @fiddle/shared test`
Expected: PASS. Key auto-derivations that must stay green without manual edits: `SYNTH2_LEAF_SCHEMAS` (schema.ts), accept-list patterns, `DEFAULT_SYNTH2_PARAMS` (now includes `lfo*.sync=false`, `lfo*.div='1/16'`), `SYNTH2_ENUM_VALUES` (now includes `lfo1.div`/`lfo2.div`).

Run: `npm -w @fiddle/shared run build` (or `npx tsc -p packages/shared`) — confirm the `Synth2LfoParams` change typechecks.

If any *other* shared test carries a hardcoded key list or count that now needs the 4 rows, update it to match (the two fixtures in Step 7 are the known ones; count-based assertions like `PARAM_COUNT === SYNTH2_DESCRIPTORS.length` and `leafCount === SYNTH2_DESCRIPTORS.length` are dynamic and stay green).

- [ ] **Step 11: Commit**

```bash
git add packages/shared/src/engines/lfo-sync.ts packages/shared/src/engines/lfo-sync.test.ts packages/shared/src/engines/index.ts packages/shared/src/engines/synth2-descriptors.ts packages/shared/src/engines/synth2.ts packages/shared/src/engines/synth2-descriptors.test.ts packages/shared/src/engines/synth2.test.ts
git commit -m "feat(shared): LFO tempo-sync division table + lfo*.sync/div descriptors

<trailer per Global Constraints>"
```

---

## Task 2: Knob value formatting — hz decimals (Part A) + labels

**Files:**
- Create: `packages/client/src/ui/knobFormat.ts`
- Create: `packages/client/src/ui/knobFormat.test.ts`
- Modify: `packages/client/src/components/Knob.vue`

**Interfaces:**
- Produces (consumed by Task 4 via the Knob template): `Knob.vue` accepts an optional `labels?: string[]` prop; when present the readout is `labels[Math.round(modelValue)]`.
- `formatKnobValue(format: KnobFormat | undefined, value: number, labels?: readonly string[]): string`.

This extracts the readout logic out of `Knob.vue` (mirroring how `ui/knobTaper.ts` already holds the curve math) so it is unit-testable, then adds the two new behaviours. Behaviour for every existing format must be byte-identical except the hz `< 10` branch.

- [ ] **Step 1: Write the failing formatter test**

Create `packages/client/src/ui/knobFormat.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatKnobValue } from './knobFormat';

describe('formatKnobValue — hz (Part A: sub-10 decimals)', () => {
  it('shows decimals below 10 Hz (trailing zeros trimmed)', () => {
    expect(formatKnobValue('hz', 0.25)).toBe('0.25Hz');
    expect(formatKnobValue('hz', 0.5)).toBe('0.5Hz');
    expect(formatKnobValue('hz', 2.5)).toBe('2.5Hz');
    expect(formatKnobValue('hz', 9.99)).toBe('9.99Hz');
  });
  it('rounds to whole Hz from 10 up to 1000 (unchanged)', () => {
    expect(formatKnobValue('hz', 10)).toBe('10Hz');
    expect(formatKnobValue('hz', 440)).toBe('440Hz');
    expect(formatKnobValue('hz', 999)).toBe('999Hz');
  });
  it('uses k above 1000 (unchanged)', () => {
    expect(formatKnobValue('hz', 2000)).toBe('2.0k');
  });
});

describe('formatKnobValue — labels', () => {
  it('renders labels[round(value)] when a labels array is given', () => {
    const labels = ['1/1', '1/2', '1/4', '1/8'];
    expect(formatKnobValue(undefined, 0, labels)).toBe('1/1');
    expect(formatKnobValue('hz', 2, labels)).toBe('1/4'); // labels win over format
    expect(formatKnobValue(undefined, 2.4, labels)).toBe('1/4'); // rounds
  });
  it('falls back to normal formatting when labels is absent or out of range', () => {
    expect(formatKnobValue('percent', 0.5)).toBe('50%');
    expect(formatKnobValue(undefined, 9, ['a', 'b'])).toBe('9'); // index 9 out of range
  });
});

describe('formatKnobValue — existing formats unchanged', () => {
  it('formats percent / ms / cents / ratio', () => {
    expect(formatKnobValue('percent', 0.5)).toBe('50%');
    expect(formatKnobValue('ms', 0.2)).toBe('200ms');
    expect(formatKnobValue('cents', 7)).toBe('+7c');
    expect(formatKnobValue('ratio', 1.25)).toBe('1.3');
  });
  it('handles undefined/NaN value as empty string', () => {
    expect(formatKnobValue('hz', NaN)).toBe('');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm -w @fiddle/client test -- knobFormat`
Expected: FAIL — cannot resolve `./knobFormat`.

- [ ] **Step 3: Create `packages/client/src/ui/knobFormat.ts`**

Port the `switch` from `Knob.vue`'s `formattedValue` computed verbatim, add the hz `< 10` branch and the `labels` short-circuit:

```ts
export type KnobFormat = 'hz' | 'ms' | 'percent' | 'cents' | 'octave' | 'ratio' | 'db';

/** Render a knob's numeric value as its readout string. Extracted from Knob.vue
 *  so it is unit-testable (mirrors ui/knobTaper.ts). When `labels` is given and
 *  round(value) indexes into it, the label wins over `format` (used by the
 *  tempo-synced LFO Rate knob, whose value is a division index). */
export function formatKnobValue(
  format: KnobFormat | undefined,
  value: number,
  labels?: readonly string[],
): string {
  // Defensive: a param leaf missing from an old/partial snapshot can arrive as
  // undefined/null/NaN before heal — never let it throw and take down the panel.
  if (value === undefined || value === null || Number.isNaN(value)) return '';

  if (labels) {
    const label = labels[Math.round(value)];
    if (label !== undefined) return label;
  }

  if (!format) return value.toString();

  switch (format) {
    case 'hz':
      if (value >= 1000) return (value / 1000).toFixed(1) + 'k';
      // Part A: below 10 Hz the whole-number readout collapsed the LFO's usable
      // sub-1 Hz range to "0Hz"/"1Hz". Show up to 2 decimals, trailing zeros
      // trimmed. cutoff (min 20 Hz) never reaches this branch.
      if (value < 10) return `${parseFloat(value.toFixed(2))}Hz`;
      return Math.round(value) + 'Hz';
    case 'ms':
      return Math.round(value * 1000) + 'ms';
    case 'percent':
      return Math.round(value * 100) + '%';
    case 'cents': {
      const prefix = value > 0 ? '+' : '';
      return `${prefix}${value}c`;
    }
    case 'octave': {
      const rounded = Number(value.toFixed(1));
      if (rounded === 0) return '0';
      return rounded > 0 ? `↑${rounded}` : `↓${Math.abs(rounded)}`;
    }
    case 'ratio':
      return value.toFixed(1);
    case 'db': {
      if (value <= 0) return '-∞ dB';
      const db = -54 + value * 60;
      const prefix = db > 0 ? '+' : '';
      return prefix + db.toFixed(1) + ' dB';
    }
    default:
      return value.toString();
  }
}
```

- [ ] **Step 4: Run the formatter test to confirm it passes**

Run: `npm -w @fiddle/client test -- knobFormat`
Expected: PASS.

- [ ] **Step 5: Rewire `Knob.vue` to use the formatter and accept `labels`**

In `packages/client/src/components/Knob.vue`:

(a) Add the import near the top of `<script setup>` (alongside the `knobTaper`/`KnobCurve` imports):

```ts
import { formatKnobValue } from '../ui/knobFormat';
```

(b) Add `labels` to the `defineProps` object literal (after `format`) and its default:

```ts
  format?: 'hz' | 'ms' | 'percent' | 'cents' | 'octave' | 'ratio' | 'db';
  labels?: string[];
```
```ts
  format: undefined,
  labels: undefined,
```

(c) Replace the entire `formattedValue` computed body with a delegation:

```ts
const formattedValue = computed(() => formatKnobValue(props.format, props.modelValue, props.labels));
```

- [ ] **Step 6: Run the client Knob suite to confirm no regression**

Run: `npm -w @fiddle/client test -- Knob knobFormat`
Expected: PASS (existing `Knob.test.ts` still green — it asserts dial geometry and the empty-value case, none of which change; the hz readout has no existing assertion).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/ui/knobFormat.ts packages/client/src/ui/knobFormat.test.ts packages/client/src/components/Knob.vue
git commit -m "feat(client): extract knob value formatter; sub-10Hz decimals + labels prop

<trailer per Global Constraints>"
```

---

## Task 3: AudioEngine — derive the effective LFO rate

**Files:**
- Modify: `packages/client/src/audio/AudioEngine.ts`
- Modify: `packages/client/src/audio/AudioEngine.test.ts`

**Interfaces:**
- Consumes: `divisionToHz` from `@fiddle/shared` (Task 1); the `Synth2LfoParams` `sync`/`div` fields.
- Produces (behaviour Task 4's UI relies on): when a synth2 LFO has `sync=true`, the worklet receives `lfoN.rate = divisionToHz(div, bpm)`; a `bpm` change re-pushes every synced LFO; free-mode LFOs and all non-LFO params are unaffected.

- [ ] **Step 1: Write failing AudioEngine tests**

Add to `packages/client/src/audio/AudioEngine.test.ts` (the harness `makeEngine()` returns `{ project, engine, set, emit }`; switch track 0 to synth2 and drive commands). Append this `describe` block:

```ts
describe('AudioEngine — LFO tempo-sync rate derivation', () => {
  async function synth2Engine(lfo1: Partial<{ sync: boolean; div: string; rate: number }>) {
    const h = makeEngine();
    h.project.bpm = 120;
    h.project.tracks[0].engineType = 'synth2';
    Object.assign(h.project.tracks[0].engines.synth2.lfo1, lfo1);
    const state = await h.engine.ensureAudio();
    const spy = vi.spyOn(state.engines[0]!, 'applyParams');
    spy.mockClear();
    return { ...h, state, spy };
  }

  it('re-pushes a derived Hz to a synced LFO on BPM change', async () => {
    const { set, spy } = await synth2Engine({ sync: true, div: '1/16' });
    set(['bpm'], 120);
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 8 }) }); // 1/16 @ 120
  });

  it('does NOT re-push a free-mode LFO on BPM change', async () => {
    const { set, spy } = await synth2Engine({ sync: false });
    set(['bpm'], 120);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives the rate when a synced LFO div changes', async () => {
    const { set, spy } = await synth2Engine({ sync: true, div: '1/16' });
    set(['tracks', 0, 'engines', 'synth2', 'lfo1', 'div'], '1/8'); // 0.5 beat @120 → 4 Hz
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 4 }) });
  });

  it('derives the rate when SYNC is turned on', async () => {
    const { set, spy } = await synth2Engine({ sync: false, div: '1/4' });
    set(['tracks', 0, 'engines', 'synth2', 'lfo1', 'sync'], true); // 1 beat @120 → 2 Hz
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 2 }) });
  });

  it('passes the raw Hz through for a free-mode rate edit', async () => {
    const { set, spy } = await synth2Engine({ sync: false });
    set(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], 3);
    expect(spy).toHaveBeenCalledWith({ lfo1: expect.objectContaining({ rate: 3 }) });
  });
});
```

- [ ] **Step 2: Run to confirm failure**

Run: `npm -w @fiddle/client test -- AudioEngine`
Expected: FAIL — no bpm reaction (`not.toHaveBeenCalled` may pass, but the synced-derivation cases fail: the raw free rate is pushed / bpm is ignored).

- [ ] **Step 3: Add the derivation helper**

In `packages/client/src/audio/AudioEngine.ts`:

(a) Extend the shared import (currently `import { TRACK_POOL_SIZE } from '@fiddle/shared';`):

```ts
import { TRACK_POOL_SIZE, divisionToHz } from '@fiddle/shared';
```

(b) Add a module-level helper next to the existing `snapshot` helper (~line 70):

```ts
// A synced LFO's rate is derived on the main thread from its note division and
// the project BPM (the kernel is tempo-agnostic); a free LFO uses its stored Hz.
function effectiveLfoRate(lfo: { sync?: boolean; div?: string; rate: number }, bpm: number): number {
  return lfo.sync ? divisionToHz(lfo.div ?? '1/16', bpm) : lfo.rate;
}
```

- [ ] **Step 4: Derive on the build/replace path (`syncTrackToEngine`)**

Replace the final line of `syncTrackToEngine` (currently
`engines[i]!.applyParams(track.engines[targetType] as Record<string, any>);`) with:

```ts
      const params = track.engines[targetType] as Record<string, any>;
      if (targetType === 'synth2') {
        const s2 = params as unknown as { lfo1: any; lfo2: any };
        engines[i]!.applyParams({
          ...params,
          lfo1: { ...s2.lfo1, rate: effectiveLfoRate(s2.lfo1, project.bpm) },
          lfo2: { ...s2.lfo2, rate: effectiveLfoRate(s2.lfo2, project.bpm) },
        });
      } else {
        engines[i]!.applyParams(params);
      }
```

- [ ] **Step 5: Add the bpm branch + LFO override in `onCommand`**

In the `onCommand` handler, immediately after `const p = cmd.path;` and BEFORE the
`if (p[0] !== 'tracks' ...) return;` guard, insert:

```ts
      // A synced LFO derives its rate from BPM on the main thread, so a tempo
      // change must re-push the derived Hz to every synth2 engine that has one.
      // Everything else still "pulls bpm per tick" (the guard below).
      if (p[0] === 'bpm') {
        for (let i = 0; i < TRACK_POOL_SIZE; i++) {
          if (project.tracks[i].engineType !== 'synth2') continue;
          const engine = engines[i];
          if (!engine) continue;
          for (const key of ['lfo1', 'lfo2'] as const) {
            const lfo = project.tracks[i].engines.synth2[key];
            if (!lfo.sync) continue;
            engine.applyParams({ [key]: { ...snapshot(lfo), rate: effectiveLfoRate(lfo, project.bpm) } });
          }
        }
        return;
      }
```

Then, inside the `case 'engines':` block, replace the final push line
(`engine.applyParams({ [key]: snapshot(liveSlice[key]) } as Record<string, any>);`) with an LFO-aware version:

```ts
          if (slice === 'synth2' && (key === 'lfo1' || key === 'lfo2')) {
            const lfo = liveSlice[key] as { sync?: boolean; div?: string; rate: number };
            engine.applyParams({ [key]: { ...snapshot(lfo), rate: effectiveLfoRate(lfo, project.bpm) } });
            return;
          }
          engine.applyParams({ [key]: snapshot(liveSlice[key]) } as Record<string, any>);
```

- [ ] **Step 6: Run the AudioEngine suite to confirm pass**

Run: `npm -w @fiddle/client test -- AudioEngine`
Expected: PASS (new block + all pre-existing AudioEngine tests, including the generic-nested-push and replace tests, stay green).

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/audio/AudioEngine.ts packages/client/src/audio/AudioEngine.test.ts
git commit -m "feat(client): derive synced LFO rate from BPM in AudioEngine

<trailer per Global Constraints>"
```

---

## Task 4: Synth2Panel — SYNC toggle + conditional Rate knob

**Files:**
- Modify: `packages/client/src/components/Synth2Panel.vue`
- Modify: `packages/client/src/components/Synth2Panel.test.ts`

**Interfaces:**
- Consumes: `LFO_SYNC_LABELS`, `divisionLabelToIndex` (Task 1); the `labels` prop on `Knob.vue` (Task 2); the AudioEngine reaction (Task 3). All div index↔label logic is inline in the template using these imported top-level `<script setup>` bindings, so `defineProps` is NOT touched.
- The LFO SYNC buttons use a distinct class `lfo-sync-btn` (NOT `sync-btn`) so the existing osc `.sync-btn` count test stays valid.

- [ ] **Step 1: Write the failing panel test**

In `packages/client/src/components/Synth2Panel.test.ts`, append a describe block (reuse the file's existing `mountPanel`, `dispatchLocal`, `SYN2` helpers — mirror the osc hard-sync tests):

```ts
describe('Synth2Panel LFO tempo-sync', () => {
  it('renders a SYNC toggle on lfo1 and lfo2', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const lfoSyncBtns = el.querySelectorAll<HTMLButtonElement>('.lfo-sync-btn');
    expect(lfoSyncBtns.length).toBe(2);
  });

  it('dispatches lfo1.sync toggled true on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btn = el.querySelectorAll<HTMLButtonElement>('.lfo-sync-btn')[0];
    expect(params.lfo1.sync).toBe(false);
    btn.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('lfo1', 'sync'), true);
  });

  it('shows the division label on the Rate knob when synced', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.lfo1.sync = true;
    params.lfo1.div = '1/8';
    const el = mountPanel(params);
    // The synced LFO1 Rate knob readout shows the division, not a Hz value.
    expect(el.textContent).toContain('1/8');
  });
});
```

(If the file's active-track helper is named differently than `SYN2`, use whatever the osc-sync tests in this same file use — match them exactly.)

- [ ] **Step 2: Run to confirm failure**

Run: `npm -w @fiddle/client test -- Synth2Panel`
Expected: FAIL — no `.lfo-sync-btn`, no `1/8` readout.

- [ ] **Step 3: Extend the panel script imports**

In `packages/client/src/components/Synth2Panel.vue`, change the shared import (currently `import { MOD_SOURCES, MOD_DESTS } from '@fiddle/shared';`) to:

```ts
import { MOD_SOURCES, MOD_DESTS, LFO_SYNC_LABELS, divisionLabelToIndex } from '@fiddle/shared';
```

- [ ] **Step 4: Make the LFO 1 Rate knob conditional + add its SYNC button**

In the "Column 8: LFOs" section, LFO 1 `module-group`, replace the single Rate knob line with a `v-if`/`v-else` pair, and add the SYNC button after the `knob-row` div (mirroring `loop-btn` placement). The LFO 1 block becomes:

```html
      <div class="module-group">
        <h3>LFO 1</h3>
        <WavePreview kind="lfo" :shape="params.lfo1.shape" :color="color" />
        <div class="knob-row">
          <Knob v-if="!params.lfo1.sync" label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" curve="exp" :defaultValue="DEFAULTS.lfo1.rate" :modelValue="params.lfo1.rate" @update:modelValue="ks.set(['lfo1', 'rate'], $event)" :syncPath="ks.pathFor(['lfo1', 'rate'])" @gesture-end="ks.end(['lfo1', 'rate'])" />
          <Knob v-else label="Rate" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.lfo1.div)" :modelValue="divisionLabelToIndex(params.lfo1.div)" @update:modelValue="ks.set(['lfo1', 'div'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['lfo1', 'div'])" @gesture-end="ks.end(['lfo1', 'div'])" />
          <Knob label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo1.shape" :modelValue="params.lfo1.shape" @update:modelValue="ks.set(['lfo1', 'shape'], $event)" :syncPath="ks.pathFor(['lfo1', 'shape'])" @gesture-end="ks.end(['lfo1', 'shape'])" />
        </div>
        <button type="button" class="lfo-sync-btn" :class="{ active: params.lfo1.sync }" @click="ks.set(['lfo1', 'sync'], !params.lfo1.sync)">SYNC</button>
      </div>
```

- [ ] **Step 5: Do the same for LFO 2**

```html
      <div class="module-group">
        <h3>LFO 2</h3>
        <WavePreview kind="lfo" :shape="params.lfo2.shape" :color="color" />
        <div class="knob-row">
          <Knob v-if="!params.lfo2.sync" label="Rate" :min="0.01" :max="2000" :step="0.01" format="hz" curve="exp" :defaultValue="DEFAULTS.lfo2.rate" :modelValue="params.lfo2.rate" @update:modelValue="ks.set(['lfo2', 'rate'], $event)" :syncPath="ks.pathFor(['lfo2', 'rate'])" @gesture-end="ks.end(['lfo2', 'rate'])" />
          <Knob v-else label="Rate" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.lfo2.div)" :modelValue="divisionLabelToIndex(params.lfo2.div)" @update:modelValue="ks.set(['lfo2', 'div'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['lfo2', 'div'])" @gesture-end="ks.end(['lfo2', 'div'])" />
          <Knob label="Shape" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo2.shape" :modelValue="params.lfo2.shape" @update:modelValue="ks.set(['lfo2', 'shape'], $event)" :syncPath="ks.pathFor(['lfo2', 'shape'])" @gesture-end="ks.end(['lfo2', 'shape'])" />
        </div>
        <button type="button" class="lfo-sync-btn" :class="{ active: params.lfo2.sync }" @click="ks.set(['lfo2', 'sync'], !params.lfo2.sync)">SYNC</button>
      </div>
```

- [ ] **Step 6: Add `.lfo-sync-btn` to the shared button CSS**

In the `<style>` block, add `.lfo-sync-btn` to the three grouped `sync-btn`/`loop-btn` rules so it inherits the same look:

```css
.sync-btn,
.loop-btn,
.lfo-sync-btn {
```
```css
.sync-btn:hover,
.loop-btn:hover,
.lfo-sync-btn:hover { color: #aaa; border-color: #444; }
.sync-btn.active,
.loop-btn.active,
.lfo-sync-btn.active { background: #222; color: #fff; border-color: #555; }
```

- [ ] **Step 7: Run the panel suite to confirm pass**

Run: `npm -w @fiddle/client test -- Synth2Panel`
Expected: PASS (new LFO tempo-sync tests + the existing osc `.sync-btn` count-of-2 test, which is unaffected because LFO buttons use `.lfo-sync-btn`).

- [ ] **Step 8: Commit**

```bash
git add packages/client/src/components/Synth2Panel.vue packages/client/src/components/Synth2Panel.test.ts
git commit -m "feat(client): per-LFO SYNC toggle + tempo-synced Rate knob in Synth2Panel

<trailer per Global Constraints>"
```

---

## Post-Plan Verification (MANDATORY — do not skip)

Run the whole gate, then a live browser pass. Browser verification is required by repo rule before the feature can be called done — a green unit suite does not substitute.

- [ ] **Full gate:** from the repo root run `npm test` (or `npm -w @fiddle/shared test && npm -w @fiddle/client test && npm -w @fiddle/server test`) and both workspace builds (`npm -w @fiddle/shared run build && npm -w @fiddle/client run build`). All green; typecheck clean.

- [ ] **Browser (dev:obs only — NEVER `npm run dev`):** start `npm run dev:obs`, open the app (Playwright MCP), add/select a synth2 track, open its panel, and verify:
  1. **Part A:** free-mode LFO Rate knob shows sub-1 Hz decimals (drag low → readout like `0.25Hz`, not `0Hz`).
  2. **Sync on:** click LFO 1 **SYNC** — the button goes active and the Rate knob readout switches to a division label (e.g. `1/16`); dial across divisions.
  3. **Audible lock:** with the sequencer playing and the LFO routed (e.g. an LFO→cutoff matrix slot), the modulation locks to the grid.
  4. **BPM tracks:** change project BPM — the synced LFO's rate follows; a second free-mode LFO does not.
  5. **Toggle off:** click SYNC again — the knob returns to the free Hz value it had before.
  6. Console is clean (no errors/warnings). Close the browser tab/session when done.

- [ ] Report observations. Then hand off to `superpowers:finishing-a-development-branch`.

---

## Self-Review (completed by plan author)

**Spec coverage:** Part A → Task 2. Division table/constant → Task 1. 4 descriptor rows + type + fixtures → Task 1. Effective-rate derivation + bpm branch (build path, leaf-edit path, tempo path) → Task 3. UI SYNC toggle + conditional knob + div adapter → Task 4. Tests (shared table, formatter, AudioEngine, panel) → each task. Browser verification → Post-Plan. Known limitation → Global Constraints. All spec sections map to a task.

**Placeholder scan:** none — every code/test/CSS step shows the exact content; the only textual placeholder is the commit `<trailer>` marker, which points to the verbatim two-line trailer in Global Constraints.

**Type consistency:** `LFO_SYNC_LABELS`, `LFO_SYNC_DEFAULT_INDEX`, `divisionToHz`, `divisionLabelToIndex`, `Synth2LfoParams.{sync,div}`, `effectiveLfoRate`, `formatKnobValue`, and the `labels` prop are named identically across the tasks that define and consume them. The `lfo-sync-btn` class is used consistently in the panel markup, CSS, and the panel test.
