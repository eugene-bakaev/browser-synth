# Sparse Persisted Snapshot — Design

**Date:** 2026-06-06
**Status:** Approved (design) — pending implementation plan

## Problem

Every session flush rewrites the **entire** project as a single jsonb blob via
`PostgresSessionStore.saveSnapshot` (`insert … on conflict do update`). Since the
`feat/variable-track-count` work, a project always carries **all 32 pool slots ×
64 steps each**, even when only ~4 tracks are enabled — so the blob ballooned from
the **~28 KB the persistence layer was designed for** (see the comment in
`SessionStore.ts`) to **~224 KB** (8×).

`SessionSync` flushes each dirty room **every 60 s** plus **on every disconnect**.
Each flush therefore writes ~224 KB → ~8× the WAL volume, a full TOAST rewrite, and
a dead 224 KB tuple for autovacuum to reclaim. On the free-tier Supabase nano this
**depletes the Disk IO Budget** (the "your project is depleting its Disk IO Budget"
email and the recurring "Unhealthy" status), and inflates transient server RAM when
flushes back up during a DB slowdown.

**This is a write-IO problem, not a storage-capacity problem.** The dashboard's
6.91 GB is reserved system/volume overhead (Database = 0 GB); our actual data is
sub-megabyte. Capacity is explicitly out of scope.

## Goal

Cut the per-flush DB write from ~224 KB to ~28 KB (≈8×) for typical projects,
**losslessly**, by changing **only the DB-persisted form**. The in-memory project,
the WebSocket snapshot wire format, and op addressing (`tracks.N.…`) are unchanged.

Non-goals:
- No change to in-memory `RoomStore`, `SnapshotMessage`, broadcast, op paths, or
  client rendering.
- No reduction of disk **capacity** (a different, non-problematic metric).
- No change to flush cadence (a possible separate optimization, not this spec).

## Constraints that shape the design

1. **Ops address tracks by absolute pool index** (`tracks.5.steps.3.note`). Any
   slimmed form must preserve absolute slot indices on rehydration.
2. **Disabled tracks can hold real user data.** `removeTrack` is documented as
   non-destructive (`useSynth.ts`): "step/param data stays so re-adding restores
   it." The persisted snapshot is what a room reloads from after a server restart
   or grace-prune, so disabled-but-edited content **must survive** a reload.
   → the slim-down must be **lossless**, not "enabled-tracks-only".
3. **`freshTrack(false)` is fully deterministic** (`factory.ts` — no randomness, no
   timestamps). So an untouched padding slot is structurally identical to a freshly
   built `freshTrack(false)`, which makes "carries no information" decidable.

## The core rule

A pool slot is persisted **iff it carries information**:

> `track.enabled === true` **OR** the track differs from `freshTrack(false)`.

Every omitted slot is, by definition, a **pristine disabled padding slot** —
regenerated as `freshTrack(false)` on load. This:
- preserves disabled-but-edited tracks (they differ from fresh) → lossless;
- preserves enabled-but-unedited tracks (persisted because `enabled === true`);
- drops only untouched padding (the 28 slots that hold zero information) → ~8×.

Worst case (all 32 enabled) stores all 32 — correct, no win, but that is a
genuinely large project.

## Stored format (jsonb column only)

`session_snapshots.project` changes from a full `Project` to a **sparse** shape:

```jsonc
{
  "schemaVersion": 2,
  "bpm": 120,
  "tracks": { "0": {…}, "1": {…}, "2": {…}, "3": {…} }   // slot index -> full ProjectTrack
}
```

- Top-level `schemaVersion` and `bpm` are carried through unchanged.
- `tracks` becomes an **object keyed by stringified slot index** (`"0".."31"`),
  containing only the slots the core rule keeps. Each value is a full
  `ProjectTrack` (unchanged shape).

### Migration: lazy, structural discriminator — no data migration

Legacy rows store `tracks` as a **32-element array**; new rows store it as a
**keyed object**. `Array.isArray(stored.tracks)` distinguishes them:
- array → legacy full form, used as-is;
- object → new sparse form, expanded to a 32-slot array.

Existing rows therefore read correctly and are rewritten to sparse form on their
next flush. No migration script, no version bump required.

## Components

All new logic lives in `@fiddle/shared` so it is unit-testable without a database
and shared by any future store.

New file: `packages/shared/src/project/snapshot-codec.ts`

- **`packProject(project: Project): StoredProject`** — full → sparse. Iterates the
  32 slots; includes a slot iff `enabled` or `!deepEqual(track, PRISTINE_DISABLED)`.
- **`unpackProject(stored: unknown): Project`** — sparse **or** legacy-array → full
  32-slot `Project`:
  - if `tracks` is an array → use it as the slot list (legacy);
  - if `tracks` is an object → build a 32-element array, filling present indices
    from the map and absent indices with `freshTrack(false)`;
  - defensive: anything unrecognized (null, non-object, missing fields) falls
    through to a shape that `normalizeProject` will heal — `unpackProject` never
    throws.
  - `unpackProject` rehydrates **structure only**; invariant repair stays with the
    existing `normalizeProject` call at the load boundary.
- **`deepEqual(a, b): boolean`** — small structural, key-order-insensitive deep
  equality (loaded tracks may have a different key order than a freshly built one,
  so `JSON.stringify` comparison is unsafe). Compared against a module-level cached
  `PRISTINE_DISABLED = freshTrack(false)` template.

Type `StoredProject` (sparse) is defined alongside the codec.

## Data flow / wiring (server — `PostgresSessionStore` only)

- `saveSnapshot(id, project)` → write `sql.json(packProject(project))`.
- `create(input)` initial snapshot insert → `sql.json(packProject(input.project))`.
- `getSnapshot(id)` → return `unpackProject(row.project)`. The existing
  `normalizeProject` at the `ConnectionHandler` load boundary then repairs
  invariants exactly as today.
- **`InMemorySessionStore` is unchanged** — it holds the full `Project` in a Map
  (RAM; the codec is a DB-serialization concern). The risky pack/unpack logic is
  isolated in shared with its own tests rather than depending on a live DB.

## Testing

Primary oracle — **codec round-trip** (`snapshot-codec.test.ts`):
`unpackProject(packProject(p))` deep-equals `normalizeProject(p)` for:
- default project (4 enabled, 28 pristine padding);
- a project with a **disabled-but-edited** slot (must survive the round trip);
- all-32-enabled (no omission);
- an **enabled-but-pristine** slot (persisted because `enabled === true`).

Legacy read:
- `unpackProject(<full 32-element array project>)` → correct full project.

Size assertion:
- `packProject(freshProject())` keeps exactly `DEFAULT_ENABLED_TRACKS` (4) slots —
  `Object.keys(packed.tracks).length === 4`.

Defensive:
- `unpackProject(null)`, `unpackProject({})`, `unpackProject('garbage')` →
  a project that `normalizeProject` accepts; never throws.

Gate: `npm run typecheck && npm test && npm run build` all green.

## Out of scope (possible follow-ups)

- Flush-if-changed (skip a flush when the project is unchanged since last save).
- Flush cadence tuning.
- Disk capacity (unrelated; not a problem).
- Slimming the in-memory project or the wire snapshot (RAM/transfer — not the
  active fire).

## Git workflow

- New branch off `main`; do not work on `main`.
- TDD; commit the codec + its tests together, then the server wiring.
- Keep the branch for browser verification before merge. No merge/push without
  explicit instruction.
- End commit messages with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
