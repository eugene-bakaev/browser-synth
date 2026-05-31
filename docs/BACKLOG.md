# Backlog

Noticed-but-not-yet-scheduled issues. Pre-existing bugs and small follow-ups that
aren't tied to the branch currently in flight.

## Bugs

### Sequencer step OCT / LEN fields are hard to edit
**Reported:** 2026-05-31 · **Status:** open · **Area:** `packages/client/src/components/Tracker.vue`

The per-step **OCT** (octave) and **LEN** (length) number inputs on a sequencer step
can't be edited normally — you can't freely type a value or clear/delete the field.

Suspected causes (to confirm during a debugging pass):
1. **Disabled unless a note is set** — both inputs bind `:disabled="step.note === null"`
   (`Tracker.vue:115,118,129,132`). On a step with no note selected they are inert, which
   may be what the user is hitting.
2. **`v-model.number` clear/NaN behavior** — the inputs use `v-model.number="step.octave"`
   / `step.length`. Clearing a `type="number"` field bound with `.number` yields an empty
   string → `NaN`, which Vue/`v-model.number` tends to reject or revert, so deleting the
   value "doesn't stick." Typing intermediate values can also get coerced.

Fix direction (TBD): decide whether OCT/LEN should be editable when no note is set; and
replace the raw `v-model.number` with a draft-ref + commit-on-change/blur pattern (the
same approach already used for the pattern-length field via `lengthDraft` /
`commitLength` in `Tracker.vue`) so empty/partial input is handled gracefully.

Pre-existing — not introduced by the UI shell/sidebar/account refactor (that branch did
not touch Tracker/sequencer files).

### Joining a fresh room replaces the local project with an empty snapshot
**Reported:** 2026-05-31 · **Status:** open · **Area:** `sync/messageDispatch.ts`, server room init

On first PLAY, `buildSyncState()` joins the room from the URL. The server answers with a
`snapshot`, which `dispatchServerMessage` applies via `replaceProject()` — overwriting the
local (localStorage-autosaved) project. For a brand-new/empty room the snapshot is empty,
so the locally-built pattern is wiped the first time you ever play in that room.

This is independent of the UI router work (the `createMemoryHistory` fix makes room URLs
stable again, so it only bites once per new room instead of on every reload). The real fix
is to **seed a new room from the joining client's local state** when the server has no
state for that room (first joiner uploads their project), rather than handing back an empty
snapshot that clobbers local work. SAVE/OPEN file persistence is unaffected.
