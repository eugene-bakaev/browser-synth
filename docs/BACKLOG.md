# Backlog

Noticed-but-not-yet-scheduled issues. Pre-existing bugs and small follow-ups that
aren't tied to the branch currently in flight.

## Open

### A single client appears multiple times in the room presence roster
**Reported:** 2026-06-20 · **Status:** open · **Area:** sync / presence — `packages/server/src/sync/ConnectionHandler.ts`, `packages/server/src/sync/Heartbeat.ts`, `packages/server/src/room/identity.ts`

One browser (one signed-in user) can show up as **3–4 identical roster entries**
("Eugene B" ×4). It self-heals after ~a minute. It is **not** a display problem and
not caused by anything in the audio engine — it's stale WebSocket connections
surviving past their usefulness, multiplied by the authenticated reconnect path
never reusing the client's identity.

**Root cause — two bugs that compound:**

1. **Authenticated reconnects never reclaim their identity.** The client re-sends its
   saved `clientId` on every reconnect specifically so the server reuses its roster
   slot (`WsClient.ts:214-216`). The guest path honors this (resume branch,
   `ConnectionHandler.ts:330-347`), but the authenticated path takes the
   `if (msg.token)` branch first and **ignores `msg.clientId`** — `makeAuthenticatedIdentity`
   mints a brand-new `clientId` every time (`identity.ts:72`, `generateClientId()`).
   Same handle, fresh identity, **a new roster row per reconnect**.
2. **Un-cleanly-dropped sockets linger up to ~60s.** A clean close (tab close /
   navigation) removes the row instantly (`ws.ts:91-98` → `markDisconnected`). But a
   half-open drop (laptop sleep, backgrounded tab, network blip, a server redeploy,
   mobile) sends no close frame, so the server keeps the socket "connected" until the
   heartbeat reaps it after two missed pings (`Heartbeat.ts:9-10`, ~60s).

Stacked: a flaky minute where one browser reconnects 3× → 3 fresh "Eugene B"
identities + the original = 4 rows, each lingering until its dead socket's ~60s
heartbeat timeout, then dropping off ("it's gone now"). Guests are partly affected
too — in the half-open window the lingering old `clientId` trips the
`duplicate_client` guard (`:341`) and a fresh identity is minted anyway — but the
authenticated path is strictly worse because it never even attempts resume.

**Proposed fix (in priority order):**

1. Make the authenticated hello **reclaim the presented `clientId`** (mirror the guest
   resume), so a reconnecting signed-in user takes back its existing slot instead of
   spawning a new one. This removes the multiplication.
2. On takeover, **evict the superseded half-open socket immediately** (close it + free
   its slot) when a reconnect presents a `clientId` that's still marked connected,
   rather than waiting ~60s for the heartbeat. Applies to guests and authenticated
   alike.
3. (Optional) Shorten the heartbeat timeout to bound ghost lifetime for true dead
   drops that never reconnect.

Test-first; extend `ConnectionHandler.test.ts` (resume + duplicate-client coverage
already exists). Separate, smaller follow-up: collapse multiple *legitimate*
connections of the same `userId` into one roster row (cosmetic — `Identity.userId`
already carries the account id).

### Factory preset pool for the worklet drum engines (kick2 / snare2 / hat2)
**Reported:** 2026-06-21 · **Status:** open (deferred) · **Area:** `packages/client/src/project/preset.ts`, `packages/client/src/views/StudioView.vue`, + a new `factory-presets.ts`

Deferred from the worklet-drum-engines plan (Phase 2) — we don't have curated
voicings ready yet, so we'll build the preset *pool* as its own piece later. The
engines themselves ship without it (their "modern" descriptor defaults are the only
built-in voicing for now); file Save/Open of presets already works. This entry is the
design to pick up when we do it.

**What it is:** a small library of named factory voicings per engine, plus a one-line
apply UI, reusing the existing preset machinery (`Preset` shape + `applyPreset(track,
preset)` at `preset.ts`). No new persistence — presets are spread over the engine's
`DEFAULT_*_PARAMS` so they stay schema-complete.

**Shape (from the plan):**
- New module `packages/client/src/project/factory-presets.ts` exporting
  `interface FactoryPreset { name: string; preset: Preset }` and
  `factoryPresetsFor(engineType): FactoryPreset[]` (empty for engines with no curated
  set). Schema-validity covered by a test (`Schemas.<Engine>Params.safeParse`).
- Curated voicings grounded in Gordon Reid's SOS "Synth Secrets" (the TR-808/909
  topologies the engines model): **kick2** `Modern` / `808` (long, pure-ish sine,
  gentle click, some droop — the new droop knob carries this) / `909` (punchy, brighter
  click, more drive, short tail, no droop); **snare2** `Modern` / `808` / `909`;
  **hat2** `Modern` / `808` closed + an `open` variant (longer decay).
- A `<select>` "PRESET…" picker in StudioView's `.preset-controls`, populated from
  `factoryPresetsFor(focusedTrack.engineType)`, calling `applyPreset` on change. The
  existing file SAVE/LOAD PRESET stays.

When we build the broader "preset pool," fold these per-engine sets into it rather than
shipping the dropdown standalone.

### snare2 voicing / descriptor polish pass
**Reported:** 2026-06-21 · **Status:** open (deferred) · **Area:** `packages/shared/src/engines/snare2.ts` (+ kernel `Snare2Kernel.ts`)

snare2 shipped (merged) with a deliberately simple **7-param** descriptor — `tune,
bodyDecay, noiseDecay, snappy, tone, noiseHp, level` — and the second shell partial
DERIVED at a fixed `SHELL_RATIO = 1.83×`. The plan's detailed Phase-3 section had
also sketched an **8-param** variant adding a tunable **`ratio`** knob (and slightly
different ranges + a Hz-valued `noiseHp`). We chose the 7-param version to ship; the
voicing/ranges were tuned by analysis + browser objective checks, not yet by ear.

**Polish-pass items (all non-blocking; descriptor is APPEND-ONLY so additions are safe):**
- Ear-test the default voicing; adjust ranges/defaults if needed (these are pre-…
  no — snare2 is now shipped, so ranges are an ABI; range *narrowing* is unsafe,
  range *widening* and default changes are safe).
- Decide whether to **append** a `ratio` knob (tunable 2nd-partial multiple, e.g.
  1.2–2.5) for more timbral range — goes at the end of the descriptor (append-only).
- Consider per-mode shell decay or a slight shell pitch-drop for more "crack."

Fold this into the broader drum-voicing polish whenever the polish stage happens.

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
