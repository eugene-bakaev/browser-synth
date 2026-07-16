# Track Reordering (Drag & Drop) — Design

**Date:** 2026-07-15
**Status:** Approved design, pending implementation plan

## Goal

Let users reorder tracks by dragging track cards in the overview grid. The
order is shared across collaborators, persists in the session snapshot and in
saved project files, and is undoable.

## Approach (decision)

**Synced `trackOrder` permutation.** The fixed 32-slot `tracks[]` pool never
moves; a new top-level `Project.trackOrder` array holds pool indices in
display order, and the UI sorts through it.

Rejected alternatives:

- **Physically reordering `tracks[]`** (new protocol `move` message): breaks
  the system invariant that track identity = pool index. A peer's in-flight
  `tracks.3.steps…` op would land on the wrong track after a concurrent move;
  engines/gains/analysers keyed by index would need remapping mid-playback;
  new message type needs capability gating. Disqualified by the concurrency
  hazard alone.
- **Local-only order** (localStorage, per user): no persistence in the
  project or saved files, collaborators see different orders. Undercuts the
  multi-user direction.

## 1. Data model & sync

### Shared (`@fiddle/shared`)

- `Project.trackOrder: number[]` — always exactly `TRACK_POOL_SIZE` (32)
  entries, a permutation of `0..31`. Position = display position; value =
  pool index. Every slot appears, enabled or not, so enabling/disabling a
  track never touches the order.
- `factory.ts` — new projects get the identity permutation `[0, 1, …, 31]`.
- `schema.ts` — `ProjectSchema` gains `trackOrder`, validated as a 32-length
  permutation (length, integer range 0..31, no duplicates — Zod refine).
- `normalize.ts` — `normalizeProject` heals a missing or invalid `trackOrder`
  to the identity permutation. Normalize runs at every boundary (server
  snapshot load, client file open, bulk `load`), so old sessions and old
  saved files self-heal. **No schema version bump** — additive field, same
  treatment as prior additions.
- `accept-list.ts` — one new pattern: `['trackOrder']`, a **whole-array
  leaf**. Deliberate: the order must change atomically; per-element writes
  could produce a duplicated index mid-flight.

### Wire behavior

- A drag emits exactly **one** `set` op: path `['trackOrder']`, value = the
  full new permutation. The server validates via the leaf schema and applies
  per-field LWW like any other leaf.
- Concurrent drags by two users: last write wins; both sides converge to one
  complete valid order, never a merged/corrupt one.
- Old sessions: `trackOrder` is a top-level key, so the server's `setDeep`
  always has an existing parent (the project root) — the synth2 old-session
  missing-parent gap does not apply.

### Deliberately unchanged

The `tracks[]` pool, every existing op path, audio engine/gain/analyser
binding (pool-index keyed), the selection store, and `?t` URL focus all keep
using stable pool indices. Reordering is purely presentational.

## 2. UI & interaction

### Rendering through the order

- `enabledTrackEntries` (StudioView.vue) — map `trackOrder` →
  `{ track, index }`, filter to enabled slots. `index` remains the pool index
  (colors, sync paths, focus keep working untouched).
- `enabledChannels` (TrackMixer.vue) — same treatment. The mixer displays the
  shared order but has **no drag of its own**.
- Everything else (focused view, engine panels, Tracker) addresses tracks by
  pool index — no change.

### Drag gesture (overview grid only)

Native HTML5 drag-and-drop on the track cards; no new dependency.

- Card is `draggable="true"` via the card header area as the drag handle —
  knobs/steps inside the card must not initiate drags.
- While dragging: insertion indicator on the card under the pointer
  (before/after by pointer position); dragged card styled lifted/dimmed.
- On drop: compute the new permutation and
  `dispatchLocal(['trackOrder'], newOrder)` — one op, one undo step.
  Escape or dropping outside cancels.
- Permutation math is a pure helper
  `moveTrack(order, fromPoolIndex, toDisplayPos)` — unit-testable without
  mounting Vue.

### Numbering (decision: renumber by position)

Unnamed tracks always read Track 1..N top-to-bottom, where the number is the
track's **position within the enabled, ordered list** (1-based), not its pool
index: call sites that render the *default* name pass that display position
to `trackDisplayName`. Custom names unaffected. The remove-track confirm
dialog shows the number the user sees.

### Add / remove (decision: new tracks append at the end)

- `addTrack` still enables the lowest free pool slot, but also moves that
  slot to the end of `trackOrder` (one extra `set ['trackOrder']` op
  alongside the `enabled` op). Both ops belong to one user action: group them
  into a single undo step if the existing gesture/undo machinery supports
  grouping heterogeneous paths; if not, two undo steps is acceptable v1
  behavior.
- `removeTrack` just disables the slot; the order is untouched. Re-adding via
  `addTrack` moves the reused slot to the end, consistent with "new tracks
  append".

### Colors

Track colors stay pool-slot keyed (unchanged) — color follows the track as
it moves, which keeps the drag visually coherent.

### Playback

Reordering is presentational only; dragging during playback is safe and
allowed.

## 3. Edge cases & error handling

- **Remote order change mid-drag:** the drop handler computes the permutation
  at drop time from the *current* `trackOrder` ("move dragged pool index N to
  display position P"). Result is always a valid permutation; LWW settles who
  wins.
- **Bad wire values:** the Zod refine rejects wrong length, out-of-range, or
  duplicate indices → clean `value.invalid` nack; the op is never applied. A
  corrupt stored order heals to identity via `normalizeProject`.
- **Drop on itself / single enabled track:** permutation unchanged → skip the
  dispatch entirely (no op, no undo entry).
- **Focused view & selection during reorder:** both keyed by pool index —
  unaffected by construction; no code needed.

## 4. Testing

Per repo convention: logic and pure helpers only, no `.vue` mounts.

- **shared:** schema accepts identity + shuffled permutations; rejects wrong
  length, duplicates, out-of-range. Normalize heals missing and invalid
  `trackOrder`. Accept-list allows `trackOrder` and still rejects
  `trackOrder.0`. Factory emits identity.
- **client:** `moveTrack` table tests (move up, down, to both ends, no-op);
  `addTrack` appends the reused slot to the end of the order;
  display-position numbering.
- **Gate:** `npm run typecheck && npm test && npm run build` green before
  merge.

### Browser verification (mandatory, Playwright MCP against `npm run dev:obs`)

- Drag a track between positions; overview **and** mixer reflect the order.
- Unnamed tracks renumber by position.
- Reload round-trips the order (server-side persistence).
- Undo restores the previous order.
- Second tab sees the reorder live (two-client sync).
- Console clean; close all tabs/sessions when done.

## Out of scope (YAGNI)

- Drag in the mixer strip
- Touch support
- Keyboard-based reordering
- Animated FLIP transitions (insertion indicator is enough for v1)
