# Channel-Rack UI Design

**Date:** 2026-06-05
**Status:** Approved (design); pending implementation plan
**Topic:** Redesign the studio overview + mixer for the variable-track-count era

## Problem

The studio was laid out for 4 tracks. The track pool now holds up to `TRACK_POOL_SIZE`
(32) slots, with `enabled` toggling a slot on/off. Two parts of the UI were built for
~4 tracks and degrade as the count climbs:

- **Overview** (`StudioView.vue` `.tracks-grid`) wraps `Tracker` columns with
  `flex-wrap`. Each column is a fixed **275px** with note/oct/len inputs far wider than
  their 1–2 characters need. As tracks are added, the grid wraps into stacked rows —
  unlike the side-by-side channel layout musicians expect.
- **Bottom Track Mixer** (`TrackMixer.vue`) is a hardcoded `grid-template-columns:
  repeat(4, 1fr)`. With many tracks it becomes a tall, detached block, duplicating the
  per-track identity already shown in the overview.

## Goal

Replace the wrapping overview + separate bottom mixer with a **DAW-style channel rack**:
a single horizontal row of compact, uniform-width track columns that scroll sideways,
each carrying its own inline mixer controls, capped by a quiet "add track" affordance.

## Non-Goals (explicitly out of scope)

- Per-user track ownership / per-user pools.
- Naming, reordering, grouping, or recoloring tracks.
- Any change to engine panel internals (`SynthPanel`, `KickPanel`, etc.) or the
  sequencer/audio engine.
- p-locks.
- Changing the `Project` data model, the track pool size, sync paths, or the
  `mixer` state shape. This is a presentation-layer redesign only.

## Design

### 1. Overview becomes a horizontal channel rack

- `StudioView.vue` `.tracks-grid` changes from `display: flex; flex-wrap: wrap` to a
  single non-wrapping horizontal row with `overflow-x: auto`. Columns keep full height;
  the user scrolls horizontally to reach tracks beyond the viewport.
- The set of rendered columns is unchanged: `enabledTrackEntries` (enabled slots paired
  with their true pool index) in slot order, each rendered as a `Tracker`.

### 2. Compact, uniform-width track columns

- `Tracker.vue` container width shrinks from **275px to ~180px**, uniform for every
  track regardless of engine type. Internal padding is reduced (10px → ~7px).
- Step-grid input columns are trimmed to fit their real content (1–2 chars). To avoid
  dead space at a uniform width, exactly one column per track type is flexible
  (`minmax(...)`) and absorbs the slack:
  - **mono synth:** `NOTE` flexes — grid `18px 20px minmax(34px,1fr) 28px 32px`
    (mute, step, note, oct, len).
  - **poly synth:** `CHORD` flexes — grid `18px 18px 30px minmax(40px,1fr) 24px 26px`
    (mute, step, root, chord, oct, len). Poly is the widest layout; the 180px column is
    sized so poly fits, and the other types fill the slack via their flexible column.
  - **drums:** `VEL` flexes — grid `18px 20px 26px minmax(0,1fr)` (mute, step, trig, vel).
- The exact pixel values above are the design target; minor adjustment during
  implementation to hit pixel-perfect alignment is acceptable as long as: (a) every
  column is the same total width, and (b) the poly layout fits without truncating chord
  names like `maj7` / `sus4`.

### 3. Fixed-height two-row header

- The `Tracker` title bar becomes a fixed-height two-row header so its height never
  depends on content (e.g. presence of the `DEL` badge or engine-name length):
  - **Row 1:** `TRK N` (track color) on the left; `EDIT` hint + `DEL` button on the
    right (the existing `.title-badge` treatment, click-to-focus and remove-with-confirm
    behaviors unchanged).
  - **Row 2:** the engine label, always present — `SYNTH · MONO`, `SYNTH · POLY`,
    `KICK`, `HAT`, `SNARE`, `CLAP`. Derived from `engineType` (+ synth `mode`).
- The `EDIT`/`DEL` actions remain hidden in the focused view (`v-if="!isFocused"`), as
  today.

### 4. Inline mixer footer (replaces the bottom Track Mixer)

- Each `Tracker` gains a footer below the step grid containing:
  - The existing **`Knob`** component, `label="LEVEL"`, `format="db"`, bound to
    `tracks[i].mixer.volume` with `syncPath ['tracks', i, 'mixer', 'volume']` and the
    same `@gesture-end` → `endGesture(...)` wiring `TrackMixer` used.
  - **MUTE** and **SOLO** buttons (stacked, filling the remaining footer width) toggling
    `tracks[i].mixer.muted` / `tracks[i].mixer.soloed`, reusing the existing active-state
    styling (red mute, amber solo).
- Because volume/mute/solo now live on the `Tracker`, `Tracker` needs access to the
  track's `mixer` state. It already receives `trackId` (the pool index); the footer binds
  against the project track at that index. The exact prop/binding mechanism (pass the
  `mixer` object as a prop vs. the whole track) is an implementation detail for the plan,
  but it must use the same reactive `project.tracks[i].mixer` object and sync paths as
  the current mixer, so live-sync and solo/mute audio gating are unaffected.
- The note-trigger pulse LED logic currently in `TrackMixer` (`isTrackTriggered`) is not
  required in the footer for v1; the per-step `active` row highlight already shows the
  playhead. (If trivial to carry over, it may be included, but it is not a requirement.)

### 5. Bottom Track Mixer is unmounted but retained

- `StudioView.vue` no longer renders the `.mixer-section` / `<TrackMixer>` (in either the
  overview or focused view).
- `TrackMixer.vue` **remains in the codebase**, with a top-of-file comment stating it is
  intentionally retained (not dead code) for a future consolidated "master mixer" view,
  so refactors / dead-code passes do not delete it. Its import is removed from
  `StudioView.vue`.

### 6. Ghost "+" add-track column

- The current `.add-track-btn` ("+ ADD TRACK") is replaced by a quiet, dashed **ghost
  column** the same width as a track (~180px), showing only a centered `+`. It always
  sits at the end of the rack and calls the existing `addTrack()`.
- It is hidden when the pool is full (`enabledTrackCount >= TRACK_POOL_SIZE`), matching
  the current `v-if`.

### 7. Focused single-track view

- The focused view's `Tracker` carries the **same inline footer** (knob + MUTE/SOLO) as
  in the overview — one component, no special case. This is how the focused track regains
  the volume/mute/solo controls the bottom mixer used to provide.
- No other change to the focused layout (engine selector, preset controls, engine panels
  are untouched).

### 8. Consistent row height

- Step rows are a fixed, identical height across mono synth, poly synth, and drum tracks
  so the playhead row highlight lines up horizontally across adjacent columns in the rack.
- Drum velocity stays visible in the overview (as it is today); synth velocity stays
  hidden until focused (`with-vel`), as today.

## Affected files (presentation only)

- `packages/client/src/components/Tracker.vue` — width, padding, input/grid sizing,
  fixed two-row header, inline mixer footer, fixed row height.
- `packages/client/src/views/StudioView.vue` — `.tracks-grid` → horizontal scroll;
  remove `.mixer-section` + `TrackMixer` import/usage; replace `.add-track-btn` with the
  ghost column; pass mixer binding to `Tracker`.
- `packages/client/src/components/TrackMixer.vue` — add intentionally-retained comment;
  otherwise unused.
- `packages/client/src/components/Knob.vue` — reused as-is (no change expected; verify it
  fits the ~42px footer dial without layout regressions).

No changes to `@fiddle/shared`, the server, sync protocol, schema, or audio engine.

## Verification

- **Gate:** `npm run typecheck && npm test && npm run build` green.
- **Browser (Playwright MCP), per AGENTS.md — close the browser when done:**
  - Overview renders enabled tracks as a horizontal, non-wrapping, side-scrolling rack;
    columns are uniform ~180px; no console errors.
  - Each column shows the fixed two-row header (TRK N + EDIT/DEL; engine label row).
  - Inline footer knob changes `mixer.volume`; MUTE/SOLO toggle and audibly gate (solo
    isolates, mute silences) exactly as the old bottom mixer did.
  - Poly track shows `ROOT · CHORD · OCT · LEN` with chord names un-truncated; drum track
    shows TRIG + velocity; mono synth shows NOTE/OCT/LEN. Row heights align across columns.
  - Ghost "+" column adds a track; disappears at 32 enabled.
  - Focused view shows the same footer; volume/mute/solo work there.
  - The bottom Track Mixer section is gone; `TrackMixer.vue` still exists in the repo.
- **Tests:** update/extend `StudioView` / `Tracker` component tests for the footer
  controls and the removal of the bottom mixer section; existing mixer-gating audio logic
  is unchanged and its tests should still pass.

## Open implementation notes

- Exact narrowed pixel values may be tuned to land pixel-perfect alignment, within the
  uniform-width + poly-fits constraints stated in §2.
- Decide in the plan whether `Tracker` takes a `mixer` prop or the full track object;
  must preserve the existing reactive object identity and sync paths.
