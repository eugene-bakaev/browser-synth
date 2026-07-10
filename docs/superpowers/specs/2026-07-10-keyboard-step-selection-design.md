# Keyboard Command System + Step Selection & Clipboard — Design

**Date:** 2026-07-10
**Status:** Approved (brainstormed with user; all decisions below were made explicitly)
**Branch:** `feat/keyboard-step-selection`

## Goal

Build an expandable, centralized keyboard command system for the client, and
ship its first consumers: row selection in the tracker plus copy / cut /
clear / paste operations on the selected rows.

The keyboard system is the durable product; the clipboard ops are its first
registered commands. Later features (spacebar play/stop, move selection,
flip, help overlay, command palette) must be additive — new declarations, not
new infrastructure.

## Non-goals (explicit)

- **Undo/redo** — not in this slice. But every operation must remain
  invertible: all mutations flow through CommandBus leaf ops that carry
  `priorValue`, so a future undo layer records batches without rework.
- **User-rebindable keys, multi-key chords, command palette, help overlay** —
  not built. The design keeps their doors open (see Architecture), but no
  code exists whose only customer is these features.
- **Toolbar buttons for the new ops** — keyboard-only this slice. Commands
  are named/described registry entries, so buttons later are `run()` calls.
- **OS clipboard integration** — clipboard is in-memory only (session-local,
  gone on reload). The store interface would hide an OS-clipboard upgrade.
- **Multi-range / disjoint selection** — a single contiguous range on exactly
  one track is the only selection shape.

## Architecture — four layers, each ignorant of the layers above

```
KeyboardService (generic; knows nothing about tracks)
  → trackerCommands (binds commands to the stores + ops)
    → selection / clipboard stores (local-only UI state; never synced)
      → step-range ops (pure drafts + per-leaf CommandBus dispatch — the
        existing clear/shift/fill pattern; syncs multi-user for free)
```

No shared-package or server changes: step leaves are already on the sync
accept-list. Selection and clipboard state never touch the wire.

## Layer 1: Keyboard system — `packages/client/src/keyboard/`

### `keys.ts` — key language (pure, no DOM access beyond the event)

- Parses binding strings — `"mod+c"`, `"shift+arrowup"`, `"escape"`,
  `"delete"` — into a canonical descriptor `{ key, mod, shift, alt }`.
- Matches a descriptor against a `KeyboardEvent`. Matching is **strict**:
  `mod+c` does not fire on `mod+shift+c`.
- `mod` resolves to metaKey on mac, ctrlKey elsewhere, decided in exactly one
  place. Platform detection is injected so tests can force either platform.
- This is the ONLY module that reads `event.key` / modifier flags. Everything
  else treats binding strings as opaque — a future chord syntax (`"g g"`)
  changes only this module and the service's matcher, no consumer API.

### `bindings.ts` — the single shortcut table

```ts
export const KEY_BINDINGS = {
  'tracker.copy': 'mod+c',
  'tracker.cut': 'mod+x',
  'tracker.paste': 'mod+v',
  'tracker.clear': ['delete', 'backspace'],
  'tracker.cursorUp': 'arrowup',
  'tracker.cursorDown': 'arrowdown',
  'tracker.extendUp': 'shift+arrowup',
  'tracker.extendDown': 'shift+arrowdown',
  'tracker.deselect': 'escape',
} as const;
```

- One human-readable file listing every shortcut in the app.
- A command id may map to one binding string or an array of alternates.
- A command registered without a table entry is legal (palette-only later).
- A table entry without a registered command is caught by a hygiene test.

### `KeyboardService.ts` — the dispatcher

Owns the app's ONLY `window.addEventListener('keydown')` (bubble phase, not
capture). Created in `AppRuntime` beside audio/session; listener removed in
`shutdown()`. Instantiated with the bindings table and platform.

```ts
interface KeyboardCommand {
  id: string;                    // key into KEY_BINDINGS
  description: string;           // for future help overlay / palette
  context: 'global' | 'tracker'; // priority: tracker > global
  isEnabled?: () => boolean;     // evaluated at dispatch time
  allowRepeat?: boolean;         // default false; cursor movement sets true
  run: (e: KeyboardEvent) => void;
}
register(cmd: KeyboardCommand): () => void   // returns unregister fn
dispose(): void
```

Dispatch order per keydown:

1. **Editable guard** — if `event.target` is an input, textarea, select, or
   contenteditable element: do nothing, ever. Typing a track name or a
   pattern length can never trigger a shortcut. Component-local key handling
   (Enter/Esc in TrackNameEditor) keeps working untouched — bubble-phase
   listening plus this guard means the service never competes with inputs.
   The guard lives in the service, not in individual handlers.
2. **Repeat guard** — `event.repeat` is ignored unless the command sets
   `allowRepeat: true`.
3. **Match** — find registered commands whose binding matches the event.
4. **Priority** — higher-priority context wins (`tracker` beats `global`);
   within the winners, `isEnabled()` (default true) filters.
5. **Run** — the first enabled match runs; the service calls
   `preventDefault()`. If no match is enabled, the event is untouched (so
   disabled `mod+c` still lets the browser copy selected page text).

**Conflict detection:** registering a second command with the same binding in
the same context **throws immediately**. Conflicts are unshippable, not
discouraged.

### `useKeyboardCommand.ts` — Vue glue

~15-line composable: `useKeyboardCommand(cmd)` registers on setup and
auto-unregisters on unmount (`onScopeDispose`). Accepts a single command or
an array. Components never touch the listener. Non-Vue registration (a future
AppRuntime-level spacebar) calls `service.register` directly.

## Layer 2: Selection — `packages/client/src/stores/selection.ts`

Pinia store (matches `stores/project.ts` conventions). Strictly local: never
dispatched, never enqueued, never persisted.

**State:** `{ trackId: number | null, anchor: number, head: number }` —
`anchor` is where the selection started; `head` is the cursor (the moving
end). One selection app-wide, on exactly one track.

**Derived:**
- `range`: `[min(anchor, head), max(anchor, head)]`.
- `validSelection`: THE consumer-facing getter. Returns `null` when
  `trackId` is null, out of pool range, or the track is disabled; clamps the
  range to `[0, patternLength - 1]`; returns `null` if fully outside the
  window. Every consumer — rendering, `isEnabled`, ops — reads
  `validSelection`, never raw state. Pattern shrink, track disable, and
  project load can therefore never leave a phantom selection targeting rows
  that don't exist.
- `isSelected(trackId, row)`, `size` — convenience for rendering/ops.

**Actions:** `place(trackId, row)` (anchor = head = row),
`extendTo(trackId, row)` (Shift+Click; if trackId differs, behaves as
`place`), `moveCursor(delta)` (collapse & move: anchor = head = clamped
head + delta), `extendCursor(delta)` (move head only, clamped), `clear()`.

### Selection UX (Tracker.vue, both focused and compact overview views)

- The **step-number cell** (`col-step`) is the selection handle in every
  layout variant: click → `place`; Shift+Click → `extendTo`. It is dead
  space today, exists in all layouts, and is not an input — selection clicks
  never fight note selects, sliders, or trig buttons. `user-select: none` on
  the cell so Shift+Click doesn't smear text selection.
- Clicking a different track's step cell moves the selection there
  (single-selection model).
- Keyboard: ArrowUp/Down = `moveCursor(∓1)` with `allowRepeat`;
  Shift+Arrows = `extendCursor`; Escape = `clear`. When no selection exists,
  arrow commands are disabled — EXCEPT in the focused view, where the first
  ArrowUp/Down seeds the cursor at row 0 of the focused track.
- Moving the cursor in a scrolling track (>16 steps) scrolls the cursor row
  into view using the same contained-`scrollTop` adjustment the playhead
  follow uses (Tracker.vue) — never `scrollIntoView`, and it must not fight
  the manual-scroll grace period.
- Rendering: selected rows get a `.selected` class — translucent track-color
  tint (`color-mix` with `--track-color`), visually distinct from the
  playhead's `.active` and from `.step-muted`. The `head` row additionally
  gets a solid track-color left edge (the cursor mark). Both focused and
  compact layouts.
- Tracker.vue reads/writes the selection store directly (Pinia); no new
  prop/emit plumbing through StudioView.

## Layer 3: Clipboard — `packages/client/src/stores/stepClipboard.ts`

Pinia store: `rows: Step[] | null`. Copy stores deep JSON clones
(`structuredClone(toRaw(...))` — the codebase's established de-proxy
pattern) of the ENTIRE step rows: note, octave, length, velocity, muted,
isChord, chordType. Engine-agnostic by design: a synth row pastes onto a drum
track (note → trigger) and vice versa. In-memory only.

## Layer 4: Step-range operations

### Pure drafts — `packages/client/src/project/mutations.ts`

- `clearRangeDraft(start, end): Step[]` — fresh empty steps for those rows,
  built from the factory's default step (single source of "what empty
  means").
- `pasteStepsDraft(rows, cursor, patternLength): Step[]` — the rows to
  write, **clipped at the pattern window**: only rows landing at index
  `< patternLength` are produced. Pasting never silently writes into
  invisible rows past the pattern end. (Decided: window-clipping, the strict
  refinement of the earlier "drop past step 64" wording.)

### Dispatch — `packages/client/src/app/projectOps.ts`

New ops, following the exact `clearTrack`/`fillTrack` pattern (draft →
per-leaf diff → `dispatchLocal` with priors):

- `clearStepRange(trackId, start, end)`
- `pasteSteps(trackId, cursor, rows)`

A ranged variant of `dispatchStepsWindow` (offset start index) diffs only the
affected rows. This buys, with zero new machinery: multi-user sync, server
validation via the existing accept-list, nack rollback via priors, and
future-undo invertibility.

### Commands — `packages/client/src/keyboard/trackerCommands.ts`

Factory `createTrackerCommands({ selection, clipboard, project, projectOps,
focusedTrackId })` returning `KeyboardCommand[]` — a pure function of its
dependencies, unit-testable without mounting components. StudioView registers
the set via `useKeyboardCommand`.

| Command | Keys | `isEnabled` | Effect |
|---|---|---|---|
| `tracker.copy` | mod+c | valid selection | selection rows → clipboard |
| `tracker.cut` | mod+x | valid selection | copy, then `clearStepRange`; selection stays |
| `tracker.clear` | delete / backspace | valid selection | `clearStepRange`; selection stays |
| `tracker.paste` | mod+v | clipboard non-empty ∧ valid cursor | `pasteSteps` at cursor; selection becomes the pasted range |
| `tracker.cursorUp/Down` | arrows | selection exists, or focused view | move cursor (collapse) |
| `tracker.extendUp/Down` | shift+arrows | selection exists | extend range |
| `tracker.deselect` | escape | selection exists | clear selection |

Post-paste selection = the pasted range (paste-paste chains; immediate
cut/clear of what was pasted). Copy reads through `validSelection` so a
clamped range is what gets copied.

## Decisions log (from brainstorming)

1. **Scope:** selection + shortcuts work in BOTH the focused view and the
   overview rack cards.
2. **Selection UX:** mouse (click / Shift+Click on the step-number cell) AND
   keyboard cursor (arrows / Shift+arrows / Escape).
3. **Paste model:** paste at cursor, cross-track allowed, clip at the
   pattern window; selection length at paste time is irrelevant
   (Excel-style).
4. **Undo:** not now; design for it (invertible leaf ops with priors —
   already guaranteed by the CommandBus path).
5. **Clipboard:** in-memory only.
6. **Approach:** central declarative KeyboardService (Approach A), absorbing
   from "full framework" C only the durable ideas: commands as named,
   described, queryable data; bindings readable in one table; matcher
   internals swappable for future chords.

## Testing

**Unit (vitest, jsdom where DOM is needed):**
- `keys.ts`: parse/match matrix — modifiers, strictness (`mod+c` vs
  `mod+shift+c`), mac vs non-mac `mod` resolution, alternate bindings.
- `KeyboardService`: editable guard (input/textarea/select/contenteditable),
  repeat guard, context priority, `isEnabled` filtering, preventDefault
  behavior (called on run, NOT called when nothing matches), conflict throw,
  unregister, dispose removes the listener.
- `bindings.ts` hygiene test: no duplicate binding within a context; every
  entry has a registered command in the tracker command set.
- Selection store: place/extend/move/clear; `validSelection` edges — pattern
  shrink clamps, fully-out-of-window → null, disabled track → null, null
  trackId → null; cross-track place.
- Drafts: `clearRangeDraft` produces factory-default steps;
  `pasteStepsDraft` clipping at the window edge; full-row fidelity.
- `trackerCommands`: with fake deps — enablement matrix (no selection, no
  clipboard, invalid selection), copy→clipboard content, cut = copy + clear,
  paste dispatches expected rows and re-selects pasted range.
- `projectOps` new ops: leaf-op emission with correct paths and priors
  (extend the existing projectOps.test.ts patterns).

**Integration (jsdom):** mount flow — synthetic keydown on window drives
selection changes and dispatches; keydown while an input has focus does
nothing.

**Browser verification (mandatory, dev:obs, throwaway session, Playwright):**
- Select ranges by click/Shift+Click in overview AND focused views; arrows /
  Shift+arrows / Escape.
- Copy 4 rows from a synth track, paste onto a drum track at a cursor near
  the pattern end → clipped correctly, triggers appear.
- Cut and Delete clear rows; velocities/mutes travel with copied rows.
- Typing in the track-name editor and pattern-length input with an active
  selection — no shortcut fires.
- Two-tab sync check: ops in one tab arrive in the second tab.
- Playhead running while selecting — `.active` and `.selected` rows visually
  distinct; no console errors; close the browser session when done.
