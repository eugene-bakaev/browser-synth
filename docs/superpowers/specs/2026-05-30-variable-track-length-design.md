# Variable track length (polymeter) — design

**Date:** 2026-05-30
**Status:** approved (design)
**Scope:** `@fiddle/shared` (schema, accept-list, factory, types), `@fiddle/client`
(Sequencer, `useSynth`, Tracker, mutations, reconcile, storage, presets). No server
code changes beyond what the shared schema/accept-list bump implies. No DB.

## Problem

Every track is hardcoded to exactly 16 steps. The bound is baked into three places
(`STEP_COUNT` in `indicesInRange`, `z.array(StepSchema).length(16)` in the schema,
`Array.from({ length: 16 })` in the factory) and the playback loop assumes a single
global playhead (`s.currentStep = (s.currentStep + 1) % 16`, one `stepIndex` reused
for all four tracks). This rules out polymeter — tracks of different lengths looping
against each other.

## Goal

Give **each track its own independent length in the range 1–64**, sharing a single
downbeat and looping independently (polymeter). A 16-step and a 12-step track realign
every 48 steps (LCM) and drift in between. No per-track rotation, no per-track speed.

## Decisions (locked during brainstorming)

1. **Per-track length, 1–64.** Each track independent.
2. **Fixed 64-step buffer + play window.** Every track always stores 64 steps; a
   `patternLength` field controls how many play and render. Shrinking is
   non-destructive — steps beyond the window keep their data and reappear on grow.
3. **Shared downbeat, independent looping, no rotation.** All tracks start at index 0
   on play; each wraps at its own `patternLength`. No per-track start offset.
4. **Per-track playhead.** Each track highlights its own current step.
5. **Window-only editor ops.** CLR / shift / FILL and the visible grid operate on
   `0..patternLength-1`; shift wraps within the window, not the full 64 buffer.
6. **Approach A — absolute step counter, per-track modulo at consumption.** The
   sequencer drops `% 16` and emits a monotonic absolute index; the playback loop and
   UI apply `% patternLength` per track. Chosen over a per-track timer (C) because the
   spec needs only different *lengths*, not different *speeds*; A keeps the sequencer
   project-agnostic, uses one scheduler, and is phase-correct indefinitely (a 53-bit
   safe integer at ~8 steps/sec is ~35M years of headroom). Per-track *speed* (triplets,
   swing, independent tempo) is explicitly out of scope; if ever wanted it gets its own
   design (and integer clock-dividers could retrofit onto A cheaply).

## Naming

The track-level field is **`patternLength`** — `Step.length` already means note
duration in ticks and is unchanged.

## Components

### `@fiddle/shared` — types, schema, factory, accept-list

- **`types.ts`:** `ProjectTrack` gains `patternLength: number`. `steps: Step[]` is now
  a 64-element buffer (the tuple-ness is documented, not type-enforced).
- **`schema.ts`:**
  - `TrackSchema.steps`: `z.array(StepSchema).length(64)`.
  - `TrackSchema` gains `patternLength: z.number().int().min(1).max(64)`.
  - `ProjectSchema.schemaVersion`: `z.literal(2)`.
  - `StepSchema.length` (note duration, max 16) is **unchanged**.
- **`factory.ts`:** `freshTrack()` builds 64 `freshStep()`s and sets
  `patternLength: 16` (preserves today's default 16-step feel). `freshProject()` stamps
  `PROJECT_SCHEMA_VERSION` (now 2).
- **`index.ts`:** `PROJECT_SCHEMA_VERSION = 2`.
- **`accept-list.ts`:**
  - Add pattern `['tracks', '*', 'patternLength']`.
  - `STEP_COUNT` 16 → 64 in `indicesInRange`.
  - `resolveLeafSchema` gains a `patternLength` branch (a new track-level key at
    `tokens.length === 3`, alongside `engineType`) returning `trackShape.patternLength`,
    so the int(1..64) range is enforced by Zod on inbound ops.

### `@fiddle/client` — Sequencer & playback

- **`Sequencer.ts`:** remove the `% 16`; `currentStep` is a monotonic absolute counter,
  still reset to 0 in `start()`. `onStep(stepIndex, time)` now passes an absolute index.
  The sequencer remains unaware of tracks and lengths.
- **`useSynth.ts` playback loop:** `const step = track.steps[stepIndex % track.patternLength]`.
  `currentStep` ref holds the absolute index (UI mods it per track).

### `@fiddle/client` — sync

- A per-track **`patternLength` sync watcher**, `flush:'sync'` + `applyingFromNetwork`
  guard, mirroring the existing engineType/mixer/steps watchers. Required because
  `patternLength` is a new syncable field and the suppression guard only holds
  synchronously (see the sync-suppression mechanism note).

### `@fiddle/client` — Tracker UI

- Render only steps `0..patternLength-1`. Slicing preserves the reactive `Step`
  references, so in-place edits still write through to `project`.
- Playhead: highlight `currentStep % patternLength` (per-track, derived from the shared
  absolute counter).
- A **`1–64` number input** in the toolbar (beside CLR / shift / FILL). Tracker emits a
  `set-length` event; `App` writes `project.tracks[i].patternLength`, consistent with how
  CLR/shift/FILL already emit and `App` mutates the project — and that write fires the
  sync watcher. `patternLength` reaches Tracker as a prop for rendering.

### `@fiddle/client` — mutations (window-only ops)

- `clearTrack` / `shiftTrack` / `fillTrack` take `patternLength` and operate only on
  `0..patternLength-1`. `shiftTrack` wraps within the window (not the full 64 buffer).

### `@fiddle/client` — migration

- **Reconciler (`reconcile.ts`):** upgrade v1 → v2: pad each track's `steps` from 16 to
  64 with blank `freshStep()`s, inject `patternLength: 16`, bump `schemaVersion`.
  Migration runs **before** Zod validation, since the v2 schema requires `.length(64)`.
- **Presets (`preset.ts`)** and **localStorage (`storage.ts`)** projects flow through the
  reconciler, so baked-in/persisted 16-step v1 data upgrades transparently.

## Data flow

`patternLength` edit (number input) → Tracker emits `set-length` → `App` writes
`project.tracks[i].patternLength` → sync watcher fires (`flush:'sync'`) → outbox op +
re-render of the visible window. Playback: absolute `stepIndex` from sequencer →
`stepIndex % patternLength` per track → trigger + per-track playhead highlight.

## What does NOT change

- Track count stays 4 (`Project.tracks` tuple untouched).
- `Step.length` (note duration) semantics and its max-16 schema.
- The sync protocol shape, the `flush:'sync'` suppression invariant, engines.
- Per-track speed / subdivision / swing — out of scope (Approach A's ceiling, accepted).
- The preset-pool / p-locks idea — a separate cycle, gated on the DB pivot.

## Testing & verification

- **shared:** schema round-trips a v2 project (64 steps + `patternLength`); accept-list
  accepts `tracks.i.patternLength` and rejects out-of-range; `indicesInRange` allows step
  indices 0–63.
- **client:** reconciler upgrades a v1 project (16→64 pad, `patternLength: 16` injected,
  `schemaVersion: 2`); sequencer absolute counter increments without `% 16`; playback
  loop indexes `steps[stepIndex % patternLength]`; mutations (clear/shift/fill) respect
  the window; the `patternLength` sync watcher emits the correct op.
- Verification gate (must be green before merge): `npm run typecheck && npm test && npm run build`.
- Manual/Playwright: set two tracks to different lengths, play, confirm independent
  looping + per-track playhead; confirm a length change broadcasts to a second client.

## Out of scope

- More tracks; per-track speed/subdivision/swing; preset-pool p-locks; the DB pivot.
