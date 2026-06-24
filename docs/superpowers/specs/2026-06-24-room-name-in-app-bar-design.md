# Room name in the top app-bar

**Date:** 2026-06-24
**Status:** Approved (brainstorm)
**Scope:** Small, presentational. No schema, sync protocol, or audio-engine changes.

## Problem

When a user is inside a room (StudioView), the room's name is not visible
anywhere persistent. The name (`SessionMeta.name`) is shown only:

- on the **lobby** session cards, and
- inside the **SESSION settings modal** (and the modal only fetches it on open).

So once you enter a room you lose track of *which* room you're in.

## Goal

Show the current room's name in the top app-bar, left side, whenever a room is
open. Static (read-only) label.

```
☰  My Jam Session                          PLAY  BPM …  LEAVE
└── new ──┘                                └── existing transport ──┘
```

## Design

Purely additive. Four small pieces.

### 1. Shared state

Add `sessionName: Ref<string | null>` to `useSynth` and export it in the return
object, alongside `currentRoomId`. Semantics:

- `null`  — not loaded yet (or no room) → render nothing.
- `''`    — loaded, room has no title → render the fallback.
- `'…'`   — the room's name.

The ref is module-scoped like the other sync refs (`currentRoomId`,
`roomLoading`).

### 2. Loading the name (in the App shell)

The name is not fetched on connect today. Load it in `App.vue`, which already
owns the single `useSynth()` instance and renders the app-bar:

```
watch(synth.currentRoomId, async (id) => {
  if (id === null) { synth.sessionName.value = null; return; } // back in lobby
  synth.sessionName.value = null;                              // clear stale name
  try {
    const m = await getSession(id);
    if (synth.currentRoomId.value === id) {                    // guard room-switch race
      synth.sessionName.value = m?.name ?? '';
    }
  } catch {
    // non-critical: leave null (render nothing) rather than guess a title
  }
});
```

This covers **every** entry path (deep-link on mount, lobby join, room switch)
because they all funnel through `currentRoomId`. The fetch lives in the shell,
not inside `connectToSession`, to keep the sync-critical connect path — and its
unit tests — free of HTTP.

### 3. Rendering (`App.vue` app-bar)

Group the hamburger and a new room-name element on the left; the teleported
transport (`#app-bar-actions`) stays on the right.

- Render the name only when `currentRoomId !== null && sessionName !== null`.
- Display `sessionName || 'Untitled session'` — the same fallback the lobby uses
  (`LobbyView.vue`).
- Static text, not a button. Truncate with ellipsis when long so it never
  crowds the transport controls.

### 4. Keep fresh on rename

The SESSION settings modal can rename the room. After a successful
`patchSession`, `StudioView.saveMeta` sets
`synth.sessionName.value = metaName.value.trim()` so the bar updates immediately.

## Non-goals (YAGNI)

- **Remote renames** by another peer do not live-update the bar. Only the local
  user's own rename does. (No live name channel exists; adding one is out of
  scope for this change.)
- The name is **not** clickable / does not open settings. Renaming stays in the
  existing SESSION modal.

## Edge cases

| Case | Behavior |
|------|----------|
| In lobby (no room) | `sessionName = null` → render nothing |
| Room open, name still loading | render nothing until the fetch resolves |
| Room has empty title | render "Untitled session" |
| `getSession` fails | leave `null` → render nothing (don't guess) |
| Switch rooms before fetch resolves | race guard discards the stale result |
| Owner renames via SESSION modal | bar updates on successful save |
| Leave session | `currentRoomId → null` → name clears |

## Files touched

- `packages/client/src/composables/useSynth.ts` — add + export `sessionName` ref.
- `packages/client/src/App.vue` — watcher to load the name; render it in the
  app-bar left group + minimal scoped styles (truncation).
- `packages/client/src/views/StudioView.vue` — set `sessionName` after a
  successful rename in `saveMeta`.

## Verification

- Existing unit suite stays green (no sync/audio logic changed).
- Mandatory browser pass (Playwright MCP, clean console):
  - Enter a named room → name shows in the bar.
  - Enter an unnamed room → "Untitled session".
  - Rename via SESSION modal → bar updates.
  - Leave → name clears; lobby shows no name.
  - Deep-link `/r/<id>` on fresh load → name shows.
