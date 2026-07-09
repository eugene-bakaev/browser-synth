# Custom Track Names — Design

**Date:** 2026-07-09
**Branch:** `feat/track-names`
**Status:** Approved (approach + design approved in brainstorming)

## Goal

Users can rename tracks. A track with no custom name displays the default
label `Track ${index + 1}` exactly as today. Names are part of the synced,
persisted project state (multi-user ready).

## Approach (chosen: A)

`ProjectTrack` gains a `name: string` field. The empty string `''` means
"unnamed" and every label site falls back to the live default
`Track ${index + 1}`.

Rejected alternatives:
- **B — store the literal `"Track N"` at creation:** requires backfilling
  every existing session and the stored number goes stale relative to the
  slot index.
- **C — client-local names (not synced):** names would not survive reload or
  reach collaborators, contradicting the multi-user direction.

Consequences of A: no migration, old sessions heal automatically at load,
numbering stays live, and "clear the name = revert to default" falls out for
free.

## Shared model (`@fiddle/shared`)

- `packages/shared/src/project/types.ts` — `ProjectTrack` gains
  `name: string` with a doc comment: `''` = unnamed; the UI renders
  `Track ${index + 1}` as the display fallback.
- `packages/shared/src/project/constants.ts` — new
  `TRACK_NAME_MAX_LENGTH = 24`.
- `packages/shared/src/project/factory.ts` — `freshTrack()` sets `name: ''`.
- `packages/shared/src/project/schema.ts` — `TrackSchema` gains
  `name: z.string().max(TRACK_NAME_MAX_LENGTH)`.
- New shared helper `trackDisplayName(track, index)` (lives with the project
  model, exported from the shared index): returns `track.name.trim()` if
  non-empty, otherwise `Track ${index + 1}`. This is the single source of
  the fallback rule; every label site uses it. Note `index` is the pool
  index (0-based) — the helper renders `index + 1`.

## Sync path

- `packages/shared/src/project/accept-list.ts` — one new PATTERNS row
  `['tracks', '*', 'name']` and the matching `resolveLeafSchema` branch
  (`trackKey === 'name' && tokens.length === 3`, returning
  `Schemas.Track.shape.name`).
- **Server: zero changes.** Op validation flows through the shared
  accept-list; track-index bounds checks already apply to all `tracks.*`
  paths.
- **No old-session gap** (unlike engine-param appends): the op's parent (the
  track object) always exists, so `setDeep` cannot throw; and
  `normalizeProject` heals a missing `name` at every load boundary:
  - `isValidTrack` additionally requires `typeof t.name === 'string'`
  - `repairTrack` fills `name: typeof t.name === 'string' ? t.name : ''`
- `snapshot-codec.ts` — no change (stores whole `ProjectTrack` objects).

## Client UI

- **Rename control (focused view only):** in `StudioView.vue`'s focused
  header `Editing: Track N (ENGINE)`, the track-name part becomes
  click-to-edit. Click swaps the name for a text input
  (`maxlength=TRACK_NAME_MAX_LENGTH`) pre-filled with the current custom
  name (empty if unnamed). Enter or blur commits
  `dispatchLocal(['tracks', activeTrackIndex, 'name'], trimmedValue)`;
  Escape cancels without dispatching. Committing an empty/whitespace-only
  value stores `''` — the label reverts to the default.
- **Display sites switch to `trackDisplayName`:**
  - `StudioView.vue` overview Tracker cards (`:title` prop, line ~51)
  - `StudioView.vue` focused Tracker `:title` (line ~176)
  - `StudioView.vue` focused header (line ~85)
  - `StudioView.vue` remove-confirm dialog message (line ~431)
  - `TrackMixer.vue` `TRK N` label (component is intentionally unmounted but
    retained; one-line change for consistency)
  - `Tracker.vue` itself is unchanged — it already renders the `title` prop.
- Custom names display as typed (no forced uppercase).

## Error handling

- Overlong values are impossible from the UI (`maxlength`) and rejected on
  the wire by the Zod schema (`op.nack` `value.invalid`) if a client bypasses
  the input.
- Garbage/missing `name` in stored projects is healed to `''` by
  `normalizeProject`.
- Non-string values on the wire are rejected by `validatePathAndValue`.

## Testing

Shared:
- factory: `freshTrack().name === ''`
- schema: `name` accepted; > 24 chars rejected; non-string rejected
- accept-list: `tracks.3.name` writable + schema resolves; value validation
  (string ok, 25-char string nacked, number nacked); out-of-range index
  still rejected
- normalize: project lacking `name` is healed to `''`; present names ride
  through untouched; already-valid fast path requires `name`
- `trackDisplayName`: custom name, empty, whitespace-only → fallback with
  correct 1-based number

Client:
- StudioView rename interaction: click → input appears; type + Enter
  dispatches `['tracks', i, 'name']` with the trimmed value; Esc dispatches
  nothing; committing empty reverts the header to `Track N`
- Label fallback rendering in overview and focused views

Mandatory browser verification on dev:obs (throwaway session): rename a
track, see all label sites update, reload and confirm persistence, clear the
name and confirm fallback, clean console, close the browser.

## Out of scope

- Renaming from the overview (double-click on Tracker titles) — deferred.
- Uniqueness constraints on names (duplicates are allowed).
- Uppercasing/styling changes to labels.
