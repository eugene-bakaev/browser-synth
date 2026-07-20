# Atomic Track Reset-on-Add — Design

**Date:** 2026-07-20
**Status:** approved (design), pending implementation plan
**Branch:** `fix/add-track-resets-slot`

## Problem

In a live room, deleting a track and then adding a new one gives you back the
**deleted track verbatim** — same steps, same engine, same sound — instead of a
blank track. Reported against `tttt111` (`/r/rxt92he75`): 5 tracks → delete
track 5 → add track → the just-deleted track reappears.

### Root cause (confirmed)

Tracks are a **fixed pool of 32 slots** (`TRACK_POOL_SIZE`), each with an
`enabled` flag. The UI "track count" is just how many slots are enabled
(default 4, `DEFAULT_ENABLED_TRACKS`).

- **Remove** (`synthContext.ts` `removeTrack`) is one op:
  `['tracks', index, 'enabled'] → false`. Deliberately **non-destructive** —
  steps/params/engine all stay (comment: *"re-adding restores it"*).
- **Add** (`synthContext.ts` `addTrack`) does
  `findIndex(t => !t.enabled)` → re-enables the **lowest-index disabled slot**,
  which is exactly the slot just freed, with all its old content intact.

This is not a regression — `addTrack` has behaved this way since it was written
(it came out of the track-reorder pool design, spec
`2026-07-15-track-reorder-design.md`).

### Why the naive fix ("reset the slot to blank on add") is unsafe

The sync accept-list (`accept-list.ts`) is **leaf-only** for track content —
there is no whole-track/whole-engines/whole-step write op. Resetting a slot to
blank via the existing diff-dispatch would emit one op **per changed field**:
up to 448 step fields + every engine param. The send path makes that a burst:

- The Outbox (`Outbox.ts`) does **not** pace distinct paths against each other —
  each unique path flushes on its own 50 ms timer (or immediately on
  gesture-end), so a reset flushes as a burst of hundreds of near-simultaneous
  sends.
- The server token bucket (`rate-limit.ts`) is 200 burst / 100-per-sec, and
  over-budget ops are **nacked** (`ConnectionHandler.ts:156`,
  `rate.limited`). A nack makes the client **roll the leaf back**
  (`Outbox.onNack` → `applyLocal(path, priorValue)`).

A large reset burst → ops 201+ nacked → those leaves roll back to the *old*
deleted-track values → a half-reset, corrupted track. This is the exact silent
data-loss failure mode already documented in `docs/BACKLOG.md`
(`rate-limit-import-data-loss`). Routing the reset through the atomic bulk-`load`
path instead is also rejected: `loadProject` **clears the undo history**
(`undoHistory.ts:151`, "history never spans projects"), so it would wipe undo on
every add.

## Goal

"Add track" gives a **blank, fresh track**, safely (no op-storm), while a
deleted track remains restorable via **Undo**.

## Non-goals

- Changing "remove track" semantics (stays the single non-destructive
  `enabled=false` op).
- Any change to `initPatch` / `applyPreset` / step-editing ops.
- A general whole-object write facility — the atomic write is scoped to exactly
  the `['tracks', i]` path.
- Reclaiming/compacting "dirty" disabled slots (not needed; every add resets the
  slot it reuses).

## Design: an atomic whole-track `set` op

"Add track" changes meaning from *"flip a slot's `enabled` bit"* to *"put a
fresh track in the lowest free slot"*, expressed as **one atomic op** that
replaces the whole track object.

### Why an object-valued `set` (not a new protocol message)

Reusing the existing `set`-op pipeline means the Outbox throttle, self-echo,
nack-rollback, per-path watermark, snapshot codec, and server persistence all
work **unchanged** — the op is just a `set` whose `path` is `['tracks', i]` and
whose `value` is a full `Track`. A dedicated `reset-track` message was
considered and rejected: more protocol surface, and *worse* for sync — each
client would have to re-derive `freshTrack()` identically (version-fragile),
whereas the object-valued set broadcasts the exact bytes every client applies.

This is the one deliberate exception to the accept-list's "leaf-only writes"
rule, tightly scoped to the single path `['tracks', '*']` and validated against
the full `Track` Zod schema.

### Feasibility (verified against current code)

- **Client apply:** `project` is `reactive`; `applySet` → `setDeep` at
  `['tracks', i]` becomes `project.tracks[i] = freshTrack` — a reactive index
  assignment Vue tracks, so the UI re-renders. `setDeep` walks only the
  `tracks` intermediate (exists) then assigns at the index — no path break.
- **Audio:** `AudioEngine.onCommand`'s `set` handler switches on `p[2]` (the
  field under the track); a length-2 path currently falls to `default` (no
  reaction). We add a whole-track case that calls the existing
  `syncTrackToEngine(i)` + `updateMixerGains()` — the same rebuild primitive
  `replace` / `engineType` / `enabled` already use. It tears down the old engine
  and rebuilds a default `synth`; blank steps schedule nothing.
- **Server:** `indicesInRange` already range-checks any `tracks.<i>` path;
  `validatePathAndValue` gates on the shared accept-list, so one accept-list
  entry + schema covers client pre-emit and server both.
- **Undo:** `onLocalCommand(path, value, prior)` records the op with
  `prior` = the old (deleted-track) object; Undo replays `applySet(path, prior)`
  as one entry, restoring the deleted track wholesale. Because the set replaces
  the object (never mutates in place), the captured prior reference is a safe,
  detached snapshot.

### Touch points

1. **`packages/shared/src/project/accept-list.ts`**
   - Add `['tracks', '*']` to `PATTERNS`.
   - `resolveLeafSchema`: for a length-2 `tracks.<i>` path, return
     `Schemas.Track`.

2. **`packages/client/src/audio/AudioEngine.ts`**
   - In `onCommand`, before the `switch (p[2])` (or as an early length check),
     handle the whole-track set: when `p[0] === 'tracks'`, `typeof p[1] ===
     'number'`, and `p.length === 2`, call `syncTrackToEngine(p[1])` +
     `updateMixerGains()` and return.

3. **`packages/client/src/app/synthContext.ts`** — `addTrack`
   - Find the lowest disabled slot `idx` (unchanged).
   - Dispatch one atomic reset: `dispatchLocal(['tracks', idx],
     freshTrack(true), /* prior */ <the current track object>)`.
     `freshTrack(true)` has `enabled: true`, so this enables **and** clears in
     one op.
   - Keep the existing `trackOrder` move-to-end dispatch. Both dispatches share
     one synchronous task → one undo entry (burst rule).
   - `removeTrack` is unchanged.

### Behavior decisions

- **Full reset** — the new track is completely fresh: engineType `synth`, name
  cleared, patternLength 16, mixer defaults, all 10 engine slices defaults, all
  64 steps blank.
- **Always reset on add** — even when the reused slot is already pristine, so the
  model is uniform ("add = a fresh track here") with one code path and no
  is-dirty special-casing.

## Undo / redo semantics

- **Delete then Undo:** unchanged — `enabled` flips back to `true`, content
  intact.
- **Add then Undo:** the reset op's prior is the pre-add track (the deleted
  track, `enabled:false`), so Undo restores that track *and* its disabled state;
  the paired `trackOrder` op undoes in the same burst.
- **Redo** replays the reset (blank track) + trackOrder.

## Edge cases & risks

- **Wire size:** a full `Track` is one JSON object (~a few KB — 1/32 of a bulk
  `load`, which already ships fine). One message, one token. Acceptable.
- **Nack rollback of the reset:** if the server nacks the whole-track set,
  `Outbox.onNack` restores the prior track object wholesale — consistent, no
  partial state.
- **Concurrent remote edits to the same slot:** the per-path watermark treats
  `['tracks', i]` as one path; a whole-track set and a concurrent leaf edit to
  the same track are ordered by the server like any two ops. Last-writer-wins at
  the track granularity for the reset, which is the intended "this is a fresh
  track now" semantics.
- **Pool exhaustion:** not a concern — every add resets the slot it reuses, so
  there is no accumulation of un-resettable dirty slots (unlike the
  prefer-clean-slot alternative).

## Testing strategy

- **Unit (client):**
  - add-after-delete yields a blank track (steps all fresh, engineType `synth`,
    params default) — the regression test for the reported bug.
  - Undo of add restores the deleted track (content + `enabled:false`).
  - Undo of a plain delete still restores the track (unchanged behavior).
  - `addTrack` into a pristine never-used slot also yields a fresh enabled track
    (uniform path).
- **Unit (shared):** accept-list accepts `['tracks', i]` with a valid `Track`
  value and rejects an out-of-range index / malformed track.
- **Unit (server):** `ConnectionHandler` applies a whole-track set within bounds
  and nacks an out-of-range one.
- **Audio:** `AudioEngine` rebuilds the engine on a whole-track set (the new
  `onCommand` case) — a disabled→reset transition builds a default `synth`
  engine.
- **Browser verify (live room):** reproduce the exact report — 5 tracks, delete
  5, add → blank track; confirm clean console and that a second peer (or reload)
  sees the blank track. Undo brings the deleted track back.

## Rollout

Standard: implement on `fix/add-track-resets-slot` via TDD, keep the branch,
browser-verify in the running `dev:obs` room, then merge with `--no-ff`.
