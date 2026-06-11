# Backlog

Noticed-but-not-yet-scheduled issues. Pre-existing bugs and small follow-ups that
aren't tied to the branch currently in flight.

## Open

*(nothing right now)*

## Resolved

### Sequencer step OCT / LEN fields are hard to edit
**Reported:** 2026-05-31 · **Status:** fixed · **Area:** `packages/client/src/components/Tracker.vue`

The per-step **OCT** (octave) and **LEN** (length) number inputs couldn't be edited
normally — `v-model.number` on a `type="number"` input rejects/reverts empty and
partial values, so typing or clearing "didn't stick."

**Resolution:** branch `fix/step-oct-len-editing` (merged). Both fields now use
`StepNumberInput.vue` — a draft-ref + commit-on-change component (the same pattern
as the pattern-length field's `lengthDraft`/`commitLength`), so empty/partial input
is handled gracefully. The inputs remain disabled while `step.note === null` — that
part was by design (the values are meaningless without a note).

### Joining a fresh room replaces the local project with an empty snapshot
**Reported:** 2026-05-31 · **Status:** closed (overtaken by events) · **Area:** sync / room init

Reported when rooms were auto-minted from the URL and the local project was
localStorage-persisted: joining a brand-new room sent back an empty snapshot that
clobbered local work.

**Resolution:** the failure mode can no longer occur as written (re-triaged as B1 in
[`CODE_REVIEW_2026-06-09.md`](./CODE_REVIEW_2026-06-09.md)). Rooms now exist only for
real sessions and are seeded **server-side** from the durable snapshot — or from the
creator's uploaded seed project at `POST /api/sessions` (which is the "first joiner
uploads their project" fix this entry asked for). `connectToSession` resets local
state *by design* before the snapshot lands (cross-session bleed guard), and the
localStorage project path itself was removed (review S1) — file Save/Open is the
offline persistence story.
