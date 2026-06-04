# Variable Track Count (Phase 1) — Design

**Status:** Approved design, ready for implementation planning.
**Date:** 2026-06-02
**Author:** Eugene Bakaev (with Claude)

## Goal

Let a session have a variable number of tracks — users can **add** and **remove**
tracks instead of the fixed 4. In Phase 1 the tracks remain **fully shared**
(everyone edits everything, exactly as today); there is no per-user ownership
yet.

## Context: where this sits in a larger arc

The end-state vision is a shared room where each user has their own tracks, with
optional edit-access grants. That is genuinely four subsystems, and we are
building them as separate, independently-shippable phases that all share one
forward-compatible data model:

- **Phase 1 (this spec): variable track count, fully shared.** Proves the data
  model, the sync layer, and the UI reflow under a variable number of tracks.
- **Phase 2: track ownership.** Add `ownerId` per track; the server rejects
  edits from non-owners. This is where guest-vs-authenticated identity gets
  resolved. (Out of scope here.)
- **Phase 3: multi-user view / real estate.** Once counts multiply, solve "whose
  tracks do I see and how." (Out of scope here.)
- **Phase 4: edit-access grants.** Request/approve flow. (Out of scope here.)

Each phase only **adds** a field and a rule to the same track model; the Phase 1
foundation is never reworked.

## The core constraint that shapes the design

The entire sync protocol is a single op type — `set { path, value }`, per-field
last-write-wins (`packages/shared/src/protocol/types.ts`). There is **no**
structural "insert element" / "remove element" op, and the accept-list permits
only **leaf** writes (`packages/shared/src/project/accept-list.ts`).

A truly variable-length array would require either structural ops or a move to
stable track IDs (paths keyed by id instead of position). Both reopen
sync-correctness risk: removing a track shifts array indices, and any in-flight
or replayed-offline op addressed by position then lands on the wrong track —
the same class of bug as the cross-session bleed recently fixed.

**Decision: a fixed pool of track slots, each carrying an `enabled` flag.** The
`tracks` array is always full length on the wire and in memory. "Add" enables
the lowest-index disabled slot; "remove" disables a specific slot
(non-destructive — its steps/params are retained). Both are ordinary leaf LWW
boolean writes. **Nothing structural ever happens and no index ever shifts**, so
the transport stays exactly as trustworthy as it is today, and concurrent
add/remove from two users converges cleanly.

This mirrors how `patternLength` already shrinks the play window
non-destructively rather than deleting step data.

## Locked parameters

- **`TRACK_POOL_SIZE = 32`** — the fixed array length, baked into the schema and
  normalization. Sized for the Phase 2 vision (up to 4 users × up to 8 tracks
  each) so the storage shape is migrated exactly once, now, and never again.
- **No separate Phase 1 enable cap.** The only limit is the pool itself (32). A
  session may enable up to 32 tracks. (Rationale: the engines for all 32 slots
  are instantiated at init regardless of the cap, so a cap saves nothing
  structurally; dropping it removes cap-constant/guard/test code. Large shared
  sessions will look cluttered until Phase 3 adds per-user views — an accepted,
  temporary, self-inflicted cost.)
- **`DEFAULT_ENABLED_TRACKS = 4`** — a new/fresh project enables slots 0–3 (the
  four tracks users see today); slots 4–31 are disabled.
- **Minimum 1 enabled track** — the "remove" control is hidden/disabled when only
  one track is enabled.

## Data model

`packages/shared/src/project/types.ts`:

- `ProjectTrack` gains one field: **`enabled: boolean`**.
- `Project.tracks` changes from the fixed 4-tuple
  `[ProjectTrack, ProjectTrack, ProjectTrack, ProjectTrack]` to
  **`ProjectTrack[]`**, with the length invariant (`=== TRACK_POOL_SIZE`)
  enforced at the schema and normalization layers. (A 32-element tuple type is
  not worth writing; the runtime invariant is the contract.)

`packages/shared/src/project/factory.ts`:

- `freshTrack()` sets `enabled` — but the factory needs two flavors, so prefer
  `freshTrack(enabled: boolean)` or a post-step in `freshProject()`.
- `freshProject()` returns `TRACK_POOL_SIZE` slots: indices `< DEFAULT_ENABLED_TRACKS`
  enabled, the rest disabled.
- New exported constants `TRACK_POOL_SIZE` and `DEFAULT_ENABLED_TRACKS` (shared,
  re-exported from the package index).

## Sync layer

`packages/shared/src/project/schema.ts`:

- Add `enabled: z.boolean()` to `TrackSchema`.
- `ProjectSchema.tracks` changes from `.length(4)` to `.length(TRACK_POOL_SIZE)`.

`packages/shared/src/project/accept-list.ts`:

- Add `['tracks', '*', 'enabled']` to `PATTERNS`.
- Add an `enabled` branch in `resolveLeafSchema` returning
  `Schemas.Track.shape.enabled`.
- `TRACK_COUNT` (the bounds check, currently `4`) becomes `TRACK_POOL_SIZE`
  (32). `STEP_COUNT` is unchanged.

`packages/client/src/composables/useSynth.ts`:

- A new watcher syncs `tracks[i].enabled` as a leaf op (same `flush: 'sync'` +
  `applyingFromNetwork`/`syncReady` gating as the other per-field watchers — see
  ARCHITECTURE §15). It also drives the local audio/render gate (below).

`enabled` is an ordinary boolean leaf: two users toggling the same slot converge
via LWW; toggling different slots are independent fields. No new op type, no
protocol version change.

## Audio + engine wiring

`useSynth` currently sets up engines, mixer gains, per-field watchers, and the
sequencer tick in `for (let i = 0; i < 4; i++)` loops that run **once at init**.

- Those loops become `for (let i = 0; i < TRACK_POOL_SIZE; i++)`. Because all 32
  slots exist in `project.tracks` from the start, **add/remove never creates or
  destroys an engine or a watcher** — the engine graph and watcher set are
  static. Enable/disable is purely a gate.
- The **sequencer skips disabled slots** (no note scheduling); their engines stay
  idle/silent.
- Cost note: a session instantiates 32 engines + watchers up front (≈160 idle
  Web Audio nodes). Web Audio handles this comfortably. If profiling later shows
  a problem, engine instantiation can be made lazy (enabled slots only) **without
  touching the storage/sync model** — the model is the locked part.

`replaceProject` (`packages/client/src/project/storage.ts`) hard-codes
`for i<4`; it becomes `for i<TRACK_POOL_SIZE` and must copy `enabled`. Its
`source` must already be normalized to `TRACK_POOL_SIZE` (guaranteed by the
normalization step below).

## UI

`packages/client/src/views/StudioView.vue`:

- The overview `tracks-grid` already uses `flex-wrap`; rendering only **enabled**
  slots means 8 tracks wrap to two rows, 32 to eight rows, with no scrollbar
  surgery. Iterate enabled slots (preserving slot order).
- **"+ ADD TRACK"** affordance in the overview, shown while fewer than
  `TRACK_POOL_SIZE` slots are enabled. Click → enable the lowest-index disabled
  slot.
- Per-track **remove ("×")** control, shown only while more than 1 slot is
  enabled. Click → disable that specific slot (data retained).
- `TRACK_COLORS` is a fixed 4-element array today. Replace with a `trackColor(i)`
  helper that keeps the existing four colors for indices 0–3 and generates
  distinct colors (e.g. HSL hue rotation) for the rest, so any pool size has a
  color. All `TRACK_COLORS[i]` usages route through the helper.
- The bottom mixer (`TrackMixer`) renders **enabled** slots only.

Note: because "add" fills the lowest-index disabled slot, removing a middle track
then adding re-fills that hole (the new track appears in the freed position
rather than at the end). This is acceptable and predictable; the rendered list is
always compact because disabled slots are filtered out.

## Migration / normalization (the main risk area)

Bumping the stored array from 4→32 means existing stored projects (4 tracks, no
`enabled`) must be normalized before a 32-slot client/engine touches them. This
change is **additive** (new field + longer array, no rename/remove/semantic
change), so per the repo's versioning policy (`migrations.ts`) it needs **no
`schemaVersion` bump** — it is handled by padding/defaulting, exactly like the
v1→v2 16→64 step growth.

**Approach: one shared normalization primitive, applied at every deserialize
boundary.**

- Add a pure `normalizeTrackPool(project)` (or extend the shared factory) in
  `@fiddle/shared` that:
  - pads `tracks` to `TRACK_POOL_SIZE` with fresh **disabled** tracks;
  - defaults `enabled` on existing tracks to **`true`** (a stored legacy track
    was active) and on padded tracks to **`false`**;
  - is idempotent (already-32-slot input passes through unchanged).
- Apply it at:
  - **Client localStorage load** — fold into `reconcileWithDefaults`
    (`storage.ts`), changing its hard-coded `[0,1,2,3].map(...)` to span
    `TRACK_POOL_SIZE` and set `enabled`.
  - **Client file open** — same path (`deserializeProject` already calls
    `reconcileWithDefaults`).
  - **Client snapshot receipt** — normalize the incoming `snapshot.project`
    before `replaceProject` (`messageDispatch.ts`), so a snapshot from an older
    server cannot under-fill the 32-slot model.
  - **Server snapshot load** — `PostgresSessionStore.loadSnapshot` (and the
    `InMemoryRoomStore`/`SessionLoader` path) normalize the loaded project, so
    every served snapshot is already 32-slot and a re-save self-heals the stored
    row. This is the boundary that touches the shared prod DB; it has been
    explicitly approved.

**Verify during implementation:** whether the server ever runs
`ProjectSchema.parse` on a whole stored snapshot. If it does, normalization must
precede that parse (otherwise old rows fail the new `.length(32)`). The
op-value validator (`resolveLeafSchema`) does not parse whole projects, so op
handling is unaffected beyond the `enabled` path addition.

## Error handling

- Out-of-range track index in an op: already nacked by `indicesInRange`
  (now bounded by `TRACK_POOL_SIZE`).
- "Remove" when 1 enabled: UI prevents it (control hidden); no op emitted.
- "Add" when 32 enabled: UI prevents it (control hidden); no op emitted.
- Corrupted/short stored project: normalization pads and defaults; never throws
  for additive shape gaps (consistent with `reconcileWithDefaults`).

## Testing

- **shared/factory:** `freshProject()` returns 32 slots, 4 enabled.
- **shared/schema:** `ProjectSchema` accepts a 32-slot project with `enabled`;
  rejects wrong lengths; `enabled` path resolves to a boolean leaf.
- **shared/accept-list:** `tracks.5.enabled` is writable and bounds-checked;
  `tracks.32.enabled` is out of range.
- **shared/normalize:** padding a 4-track legacy project yields 32 slots with the
  original 4 enabled and `enabled=true`, the rest disabled; idempotent on a
  32-slot input.
- **client/useSynth:** toggling `enabled` emits a leaf op (gated by `syncReady`);
  an inbound `enabled` op updates state without echoing; the sequencer does not
  schedule notes for a disabled slot; enabling the lowest disabled slot / adding
  / removing behaves per the rules above.
- **server:** loading a legacy 4-track snapshot serves a normalized 32-slot
  snapshot; an `enabled` op round-trips and persists.

Per repo conventions: test logic/composables/pure helpers; do **not** mount
`.vue` files. Gate before merge: `npm run typecheck && npm test && npm run build`
plus `npm run test:e2e:server`. Browser-verify the add/remove flow via Playwright
and close the browser when done.

## Files touched (overview; the implementation plan will be exhaustive)

- **shared:** `project/types.ts`, `project/factory.ts`, `project/schema.ts`,
  `project/accept-list.ts`, a normalization helper (+ index re-exports), tests.
- **client:** `composables/useSynth.ts` (loops `4→TRACK_POOL_SIZE`, `enabled`
  watcher + audio gate), `project/storage.ts` (`reconcileWithDefaults`,
  `replaceProject`), `sync/messageDispatch.ts` (normalize snapshot),
  `views/StudioView.vue` (add/remove UI, `trackColor`), the mixer component,
  tests.
- **server:** `accept-list` bound flows through; `PostgresSessionStore` /
  `SessionLoader` snapshot normalization, tests.

## Non-goals (explicitly deferred)

- Per-user track ownership and edit-permission enforcement (Phase 2).
- Guest vs authenticated identity stability for ownership (Phase 2).
- Per-user / focused multi-user track views and large-count real-estate UX
  (Phase 3).
- Edit-access request/approve flow (Phase 4).
- Reclaiming/compacting disabled slot data (removal is intentionally
  non-destructive).
