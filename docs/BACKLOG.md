# Backlog

Noticed-but-not-yet-scheduled issues. Pre-existing bugs and small follow-ups that
aren't tied to the branch currently in flight.

## Open

### Post-Phase-5 audit: re-verify the project-writer inventory is complete
**Reported:** 2026-07-02 · **Status:** open / scheduled AFTER Phase 5 lands · **Area:** lifecycle-architecture redesign — the "single writer" claim behind `packages/client/src/sync/CommandBus.ts` + `packages/client/src/audio/AudioEngine.ts`

The Phase 5 design ([spec](./superpowers/specs/2026-07-02-phase5-appruntime-design.md),
"Complete writer inventory") rests on one load-bearing claim: **every code path
that mutates `project` is known and routed through the CommandBus.** Once Phase 5
deletes the audio watchers, a *missed* writer fails silently and staged: state and
UI still update (reactive), but the write never reaches audio (no stream event)
and never syncs — no error, no test failure unless a test covers that exact flow;
just a control that stops changing the sound in one scenario.

**Evidence so far (all clean, pre-implementation, 2026-07-02):**
1. Mechanism-level greps: every `setDeep` call site (4, all accounted), every
   `replaceProject` call site, every in-place mutation helper + its callers.
2. `.vue` sweep: zero `v-model` bindings into reactive slices, zero direct
   assignments to `params`/`project`/`track`/`step` in any component (the Phase 2b
   migration got all component writers).
3. The plan encodes the claim as must-pass greps (whole-branch Verification
   section of [the plan](./superpowers/plans/2026-07-02-phase5-appruntime.md)).
4. Browser checkpoints after plan Tasks 3/4 deliberately drive the
   previously-bypassing flows (preset load, INIT PATCH, Clear/Shift/Fill,
   Open/New, remote edits).

**What this audit does (after the Phase 5 branch merges):** re-run sweeps 1–2
against the MERGED tree (code moved during Tasks 1–4; the pre-implementation
sweep does not cover code written by the implementation itself), plus:
`grep -rnE '\bproject\.(bpm|tracks)\b.*=' packages/client/src --include='*.ts' --include='*.vue' | grep -v test`
for bare property assignments, and an ear-test pass over every control category
(knob, select, toggle, step cell, mixer, bulk op, preset, remote edit) confirming
each audibly reaches the engine. Close the entry with the sweep transcript.

### AppRuntime shutdown hardening
**Reported:** 2026-07-03 · **Status:** open (deferred, zero-risk polish) · **Area:** `packages/client/src/audio/AudioEngine.ts`, `packages/client/src/sync/CommandBus.ts`, `packages/client/src/sync/SyncSession.ts`

Two deferred Minors from the Phase 5 (`feat/phase5-appruntime`) final whole-branch
review, plus one related sweep item — none are regressions, all pre-existing shape
carried into the new composition root:

1. **Dispose-during-bootstrap race.** If `shutdown()` runs while
   `AudioEngine.buildAudioState()` is still in flight (`ensureAudio`, ~`AudioEngine.ts:286-295`),
   `dispose()` early-returns on a null `audioState` (~`AudioEngine.ts:373-375`) because
   there's nothing to tear down yet — but the in-flight promise then resolves and
   installs a live AudioContext + stream subscription *after* shutdown. Dev/HMR-exposure
   mainly (a real page unload doesn't usually race a first `ensureAudio()`). Fix sketch:
   a `disposed` flag set by `dispose()` and checked in the `buildAudioState().then(...)`
   continuation — if set, dispose the just-built state instead of installing it.
2. **CommandBus emit hardening.** `emit()` (`CommandBus.ts` ~50-52) calls every stream
   listener in a plain loop with no per-listener try/catch — a throwing subscriber
   blocks the outbound enqueue in `dispatchLocal`. This is watcher-era parity (the old
   `flush:'sync'` watchers had the same fragility), not a regression, but worth
   hardening now that the bus is the sole writer. Fix sketch: wrap each listener call
   in try/catch + `console.error`.
3. **`SyncSession`'s `beforeunload` listener is never removed.** Lazily installed
   (`installLeaveFlushHandler`) but has no matching `removeEventListener` in `dispose()`.
   Harmless today (the listener is idempotent and the page is unloading anyway) —
   worth sweeping in the same pass as #1/#2 rather than fixing in isolation.

### Lost durable project data on several recently-edited prod sessions — mechanism unproven
**Reported:** 2026-06-26 · **Status:** open / investigation PAUSED · **Area:** sync durable-write path + client reconnect churn — `packages/client/src/composables/useSynth.ts` (connectToSession / leaveSession / resetLocalProject / teardownConnection), `packages/client/src/sync/reconcileSession.ts`, server flush (`SessionSync` / `packProject`)

**Symptom:** Several recently-touched prod sessions show blank/default content — all 4 tracks reset to default `synth`, steps gone. Confirmed: `e873e07as` ("test_new_engines"); also reported `c25x88ba5`, `637egh9tp`. Older sessions (Jun 6–20) are intact.

**Confirmed facts:**
- `e873e07as` durable content changed from CLAP2 + steps → 4×`synth`, written ~13:37–13:46 UTC on 2026-06-25 — DURING controller testing of the back/forward nav fix.
- **Key clue: bpm SURVIVED** (130, not reset to `DEFAULT_BPM` 120). This RULES OUT a wholesale `replaceProject(freshProject())` leak (that would reset bpm too). So either 4 isolated `engineType→synth` ops leaked with no bpm op, or a partial replace kept bpm.
- DIFFERENT root cause from the engine-revert bug (stale Render server — now fixed; see memory `stale-prod-server-render`). The stale server can't even WRITE a worklet engine, so it authored neither e873e07as's earlier clap2 state nor its reset.

**Process footgun (the actual trigger):** the loss happened because local testing ran `npm run dev`, which points the local server at the REAL prod Supabase DB. Local testing MUST use `npm run dev:obs` (local Docker DB). Separate followup: harden `npm run dev` so it cannot silently target prod.

**Recovery — likely NOT possible:**
- Client `localStorage` is NOT a source: the old localStorage load/autosave path was removed (`useSynth.ts:62–64`); the room snapshot always replaces the project; offline persistence is file save/open only (`file-io.ts`).
- Server op log / ring buffer: in-memory, lost on spin-down. Gone.
- OpenObserve OTel logs: corruption ran under `npm run dev` (prod DB, OTel OFF) → likely not captured.
- Supabase free tier: no PITR / daily backups by default. **Only remaining hope: check Supabase dashboard → Database → Backups** in case a paid plan / PITR is enabled.

**To prove the mechanism (next step):** reproduce on the SAFE local Docker DB (`dev:obs`). Check out `fix/history-nav-session-sync` (branch tip `0173b37`, now merged via `cc9c069`), create a local session with worklet engines + steps + non-default bpm, snapshot the durable row, then replay the nav churn the fix introduced (back/forward popstate; pageshow bfcache-restore force-reconnect; leave/rejoin) with op-logging on. Watch for `engineType→synth` ops reaching the durable store while bpm stays put. Determine whether the bug is in the FIX branch only or also latent on the pre-merge `main` (the fix is now ON `main`, so if it leaks it is affecting prod users NOW — urgent).

**⚠️ Merged anyway:** `fix/history-nav-session-sync` was merged (`cc9c069`) + pushed to prod on 2026-06-26 at explicit user direction, accepting the data-loss risk. It is now LIVE — so proving the mechanism is **urgent**: if sessions blank again post-deploy, this is the prime suspect and it is already shipped.

### A single client appears multiple times in the room presence roster
**Reported:** 2026-06-20 · **Status:** open · **Last confirmed:** 2026-06-27 (live, OpenObserve) · **Area:** sync / presence — `packages/server/src/sync/ConnectionHandler.ts`, `packages/server/src/sync/Heartbeat.ts`, `packages/server/src/room/identity.ts`, `packages/server/src/room/InMemoryRoomStore.ts`, `packages/server/src/otel/log.ts`

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

**Confirmed live — 2026-06-27 (OpenObserve, local `dev:obs`).** Reproduced the count
directly: lobby session "123" = roomId `nw4a52rfd` showed `● 3`. Querying the
`client live` log stream for that room over 48h returned **6 distinct `clientId`s,
all the same authenticated user** ("Євген Бакаєв"), each joining exactly once — the
empirical signature of root cause #1 (auth reconnect mints a fresh `clientId`). Joins
~30 min apart were still counted, i.e. genuinely-live background tabs, not
stale-draining ones (heartbeat reaps a dead socket within ~60s). Presence is
`connected: Set<clientId>` (`InMemoryRoomStore.ts:222` → lobby badge =
`connected.size`), so N tabs of one account = N "members". Cross-checked: guests DO get
distinct identities (Playwright joined *other* rooms as guest "Owl"), but presence is
per-room, so they never inflated "123".

**Logging gap (worth fixing alongside).** OpenObserve only carries `client live`
(joins), `room pruned after grace`, `guest session pruned after grace` — **no
disconnect event**. The `ws close` line is written via pino (`app.log`,
`routes/ws.ts:94`) directly, bypassing the OTel `log()` callback that `client live`
uses (`otel/log.ts` ← `ConnectionHandler.ts:411`). Net: you can see who *joined* but
never who *left*, so the live presence set can't be reconstructed and staleness can't
be proven from logs alone. Small fix: emit `client disconnected` (and/or route
`ws close`) through the same `log()` callback.

**userId-dedup follow-up — design (display-only; safe for multi-user testing).**
Transport and presence are separate layers: ops + `presence.update` fan out
per-**socket** via `ConnectionPool` (`pool.others`, `ConnectionHandler.ts:248,405`),
never via `connected`. So deduping presence by `userId` is purely a **display** change
— every open tab keeps its socket and still receives every update; only `listConnected`
(roster) and the lobby `connected.size` count collapse same-`userId` rows. It must NOT
touch the grace/GC decision, which correctly keys off `pool.size` (sockets) — closing 2
of 3 tabs leaves `pool.size === 2`, no premature prune. Multi-user testing is preserved:
dedup merges only the *same* `userId`, so two guests (`userId: null`), guest + user, and
two different accounts all stay distinct — you just can't fake N members by opening one
account in N tabs (use guests / incognito / a second account, as before). **Recommend
dedup by `userId` only** (guests stay per-connection); deduping a single guest browser's
tabs would need the stable localStorage `g_` id threaded into the WS `Identity` (not
there today) — skip. Apply at `listConnected` + the count at `InMemoryRoomStore.ts:222`,
consistently so roster and badge agree. Note this is complementary to fix #1 above (which
removes the *source* of the duplicate auth rows); dedup collapses whatever multiplicity
remains.

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

### clap2 voicing — doesn't sound like a convincing hand-clap
**Reported:** 2026-06-23 · **Status:** open (deferred) · **Area:** `packages/client/src/engine/clap2/kernel/Clap2Kernel.ts` (+ descriptor `packages/shared/src/engines/clap2.ts`)

clap2 shipped (merged) end-to-end and is technically correct — the worklet loads,
params persist, the perceptual tapers and Bursts integer format all verified — but on
ear-test it **does not sound close to a real hand-clap**. Merged anyway by user
decision; the sound is the open item.

The current model (the 909 "burst+room" recipe from the plan): white noise → fixed-Q
(1.2) Chamberlin SVF bandpass at `tone`, gated by a burst train of `bursts` (2–5)
transients spaced by `spread` (each 0.5 ms attack + `exp(body)` decay), summed with one
longer `exp(room)` reverberant tail, balanced by `mix`. Deterministic xorshift32 noise.

**Why it likely falls short (hypotheses to test by ear, not yet diagnosed):**
- The burst transients may be too uniform — real claps have **irregular** inter-burst
  spacing and decreasing amplitude across the 3–4 slaps, not even spacing/equal level.
- A single fixed-Q bandpass is a thin spectral model; real claps have a broader,
  resonant **hand-cavity formant** plus more high-frequency content on the attack.
- The "room" tail may read as reverb rather than the diffuse final slap; its
  shape/level relative to the bursts is suspect.
- 0.5 ms attack on each burst may be too soft — clap transients are sharper.

**Polish-pass items (descriptor is APPEND-ONLY, so additions are safe; range
*narrowing* is unsafe post-merge, widening + default changes are safe):**
- Add per-burst amplitude decay and slight randomized spacing (deterministic, seeded)
  so the slaps aren't a uniform train.
- Revisit the spectral shaping — wider/voiced bandpass or a small formant stack;
  consider more attack brightness.
- Re-balance burst vs. room and re-voice the room tail; ear-test against reference
  909/human claps.
- Consider appending a knob (e.g. `attack` sharpness or burst-decay slope) if the
  fixed values prove too limiting — append at the end of the descriptor.

Fold into the broader drum-voicing polish stage alongside snare2/kick2/hat2.

### local-init.sql missing the 0005_presets table
**Reported:** 2026-07-02 · **Status:** open · **Area:** `packages/server/db/local-init.sql`, `supabase/migrations/0005_presets.sql`

local-init.sql missing 0005_presets table — /api/presets 500s on the local Docker
DB (fold supabase/migrations/0005_presets.sql into packages/server/db/local-init.sql).
Pre-existing env gap found during Phase 5 (`feat/phase5-appruntime`) browser-verification
checkpoints, unrelated to the Phase 5 code changes.

### Outbox treats `rate.limited` as authoritative
**Reported:** 2026-07-04 · **Status:** open · **Area:** `packages/client/src/sync/Outbox.ts`, `packages/client/src/app/projectOps.ts`

Any >200-op burst of regular set ops (e.g. FILL/CLEAR across several long tracks)
still loses leaves: the tail is nacked `rate.limited` and rolled back with no retry
(`packages/client/src/sync/Outbox.ts` onNack ignores the code). The bulk load (D19)
removed the biggest source (whole-project import storms), not the class. Fix
direction: re-queue `rate.limited` nacks with backoff instead of rolling back.

### Remove the whole-project diff fallback
**Reported:** 2026-07-04 · **Status:** open (blocked) · **Area:** `packages/client/src/app/projectOps.ts`, `packages/client/src/sync/WsClient.ts`

Once prod is verified on the D19 load path, delete `snapshotProjectForSync` /
`enqueueWholeProjectDiff` / `enqueueLeafDiff` / `enqueueMatrixDiff` from
`packages/client/src/app/projectOps.ts` and the `capabilities` gate check (keep
the welcome field for old-server fallback detection). Blocked on: prod deploy +
browser sign-off.

### Migrate modal/sidebar Escape handling into the keyboard command system
**Reported:** 2026-07-10 · **Status:** open · **Area:** `packages/client/src/keyboard/KeyboardService.ts`, `packages/client/src/components/BaseModal.vue`, `packages/client/src/App.vue`

Final whole-branch review of `feat/keyboard-step-selection` found that
`KeyboardService` is not, in fact, the app's only window keydown listener:
`BaseModal.vue` (Escape closes the dialog) and `App.vue` (Escape closes the
nav sidebar) each still install their own. `KeyboardService.handleKeydown`
now stands down entirely (no command runs, no `preventDefault`) whenever an
`[aria-modal="true"]` element is present in the document, so tracker commands
(deselect, clear, paste, …) can no longer fire invisibly behind an open
modal — see the decisions-log addendum in
[the design spec](./superpowers/specs/2026-07-10-keyboard-step-selection-design.md#decisions-log-from-brainstorming).
That guard is a stand-in, not the real fix: the sidebar isn't a modal, so
Escape still both closes it *and* runs `tracker.deselect` at the same
keystroke (accepted for now — low-harm, non-destructive overlap). The proper
fix is to bring both the modal and the sidebar into the keyboard system as a
higher-priority overlay/modal `KeyboardContext` (outranking `tracker` the way
`tracker` outranks `global` today), at which point the aria-modal stand-down
guard in `handleKeydown` is deleted in favor of that context winning
dispatch normally.

### `keys.ts` letter-shortcut matching breaks on non-Latin keyboard layouts
**Reported:** 2026-07-10 · **Status:** open · **Area:** `packages/client/src/keyboard/keys.ts`

Flagged in the `feat/keyboard-step-selection` final review. Binding matching
compares `e.key` against the parsed binding string (e.g. `'mod+c'` checks
`e.key === 'c'` plus modifiers). `e.key` reflects the *typed character* under
the active keyboard layout, so a user on a Cyrillic (or other non-Latin)
layout pressing the physical key at the "C" position produces `e.key ===
'с'` (Cyrillic es) or similar — it never equals `'c'`, so every
letter-keyed tracker/global shortcut silently fails to match for those
users. `e.code` (e.g. `'KeyC'`) is layout-invariant and would fix this, but
changing the matcher from `key` to `code` is a real behavior change for
letter bindings (need to keep `key`-based matching for non-letter keys like
`ArrowUp`/`Delete`, which don't have this problem and where `code` would be
wrong for punctuation-remapped layouts). Needs its own small design pass, not
a drive-by fix.

### `selection.clear()` on bulk project load / room switch
**Reported:** 2026-07-10 · **Status:** open · **Area:** `packages/client/src/stores/selection.ts`, `packages/client/src/app/projectOps.ts` (bulk load path), `packages/client/src/sync/SyncSession.ts` (`replaceProject` / room-switch path)

Flagged in the `feat/keyboard-step-selection` final review. The selection
store's `validSelection` getter already prevents *phantom* rendering after a
bulk project load or room switch — a selection range that no longer maps
onto real content (pattern shrink, disabled track, missing trackId) resolves
to `null` and nothing highlights. But it does not prevent *stale-content*
rendering: if the old selection's row/step range still happens to exist in
the newly-loaded project (same track id, pattern long enough), it re-applies
and highlights **unrelated new content** that the user never selected — the
range is valid, just meaningless post-load. Consider calling
`selection.clear()` explicitly wherever a whole-project replace happens (bulk
project load, room switch / `replaceProject`) rather than relying on
`validSelection`'s clamping to make the old range harmless.

### De-duplicate the aria-modal `composedPath()` walk shared by the two deselect composables
**Reported:** 2026-07-12 · **Status:** open (deferred, YAGNI — extract on the third consumer) · **Area:** `packages/client/src/composables/useDeselectOnInputFocus.ts`, `packages/client/src/composables/useClickOutsideDeselect.ts`

Deferred Minor from the `feat/focus-mode-keyboard` final whole-branch review. The
new focus-deselect composable and the existing click-outside-deselect composable
each contain the identical "is this event inside an open modal?" loop:

```js
for (const node of e.composedPath()) {
  if (node instanceof Element && node.getAttribute('aria-modal') === 'true') return;
}
```

Not fixed now on purpose: there are exactly **two** identical copies, so the
rule-of-three is not crossed (a third aria-modal check exists in
`KeyboardService.isModalOpen()`, but it queries the whole document via
`querySelector`, a genuinely different shape — not a third copy of this
event-path loop). The plan also deliberately mandated mirroring the sibling
composable's shape verbatim so the two were trivially diffable in review. The loop
is a pure read-only walk with no branching subtlety, so a copy cannot silently
drift into a bug. **Trigger to act:** when a *third* `composedPath()` aria-modal
consumer appears, extract a shared helper (e.g. `pathHasOpenModal(e: Event): boolean`
in a small `composables/` or `keyboard/` util) and route all three event-path
callers through it. The final review (opus) independently concurred with deferring.

### Drag-select: mousedown + drag over steps should extend the selection
**Reported:** 2026-07-10 · **Status:** resolved 2026-07-11 (`feat/drag-select`) · **Area:** `packages/client/src/components/Tracker.vue`, `packages/client/src/stores/selection.ts`

Resolved with Pointer Events + `setPointerCapture` on `.tracker-steps` and
geometric row lookup (gap-aware pitch from sibling `offsetTop` delta), spec
`docs/superpowers/specs/2026-07-10-drag-select-design.md`. Pointer past the
visible edge overshoots one row per move so the cursor watcher provides edge
auto-scroll. Original notes follow.

User request after `feat/keyboard-step-selection` landed. Selection currently
starts only from discrete clicks on the step-number cell (`.col-step`): click
places, shift+click extends. A regular mouse press on a step cell followed by
dragging over neighboring rows in the same track should live-extend the
selection over the dragged range (the familiar text/DAW selection gesture),
committing on mouseup. Needs the usual drag mechanics: `mousedown` on
`.col-step` → `place`, `mouseover`/`mousemove` while the button is held →
`extendTo` on that row, listener teardown on `mouseup` (including mouseup
outside the track/window), and no interference with the existing click and
shift+click paths or with text `user-select` in neighboring cells. Same-track
only, matching the single-track selection model.

### Click outside a track with selected steps should cancel the selection
**Reported:** 2026-07-10 · **Status:** resolved 2026-07-11 (`feat/drag-select`) · **Area:** `packages/client/src/composables/useClickOutsideDeselect.ts`, `packages/client/src/views/StudioView.vue`

Resolved with a capture-phase document `pointerdown` listener
(`useClickOutsideDeselect`, registered in StudioView): "outside" = no
`.tracker-container` and no `[aria-modal="true"]` element in `composedPath()`.
User decision 2026-07-11: presses on the focused view's engine panel
(`.engine-section`, a sibling of the tracker card) DO clear the selection —
accepted as-is; extend the keep-zone later if it grates in practice. Original
notes follow.

User request after `feat/keyboard-step-selection` landed. Today a selection is
cleared only by Escape (`tracker.deselect`) or by placing a new one; clicking
empty page space leaves the old range highlighted. A click outside any
tracker's step area, while a selection exists, should call `selection.clear()`.
Needs a definition of "outside" (clicks on other step cells re-place the
selection already; clicks on knobs/buttons/inputs inside a Tracker card
arguably should NOT clear) and a document-level click listener that does not
swallow or race the `.col-step` click handlers — likely a capture-phase or
composedPath()-based check. Design it together with the drag-select entry
above so the two gestures share one mouse-interaction model.

## Resolved

### P0 — Reload showed a blank default project (auth-reconnect raced the initial snapshot) — FIXED
**Reported:** 2026-07-03 · **Status:** FIXED 2026-07-04 · **Area:** `packages/client/src/sync/WsClient.ts`, `packages/client/src/sync/SyncSession.ts` (auth-reconnect watcher)

**Symptom.** Signed-in user opens a session (`/r/<id>`), hits cmd+R: ~75% of the
time the app comes back "live" showing the **default fresh project** (4 ×
SYNTH·MONO, empty steps, BPM 120) instead of the room's content. The connection
looks healthy — room name in the app-bar, LEAVE present, loader gone. A further
reload sometimes fixes it. **Guests are unaffected** (which is why the Phase 4/5
browser checkpoints — all guest-mode — never caught it).

**Root cause (confirmed 2026-07-03, local repro + OpenObserve server logs).**
A boot-time race between the initial snapshot and the auth-reconnect watcher:

1. Boot with a room URL: `connectToSession` loads `freshProject()` into the
   store as a placeholder, then `wsClient.connect({ forceSnapshot: true })`
   opens socket A. Supabase hasn't restored the login yet → guest hello,
   no `resumeFromOpId` → server sends the full snapshot.
2. A few ms later `useAuth`'s `getSession()` resolves → user id flips
   `null → uid` → `SyncSession.installAuthReconnectWatcher` fires
   `wsClient.reconnect()`.
3. `reconnect()` = `disconnect()` + `connect()` **without** `forceSnapshot`.
   Socket A is superseded (its in-flight snapshot is dropped by the
   superseded-socket guard); socket B's hello carries the token AND
   `resumeFromOpId = persisted.opIdLastSeen` — the sessionStorage value from
   **before the reload** (also pre-advanced to `opIdHead` by socket A's
   welcome, before any content applied).
4. Server: `resumeFrom == opIdHead` → nothing to replay → `sync.complete`.
   Client goes live with the blank placeholder; the outbound gate opens.

Whether the user sees content is literally whether socket A's snapshot frame is
dispatched before step 2 fires — an event-loop coin flip (~25% lucky locally).

**Evidence.** Reproduced in the reporter's Chrome on `/r/zeeekndd4` (1 blank in
3 reloads); on the blank reload the OpenObserve `default` stream shows **two
`client live` handshakes 15 ms apart** (first resuming `c_jh3fxpe`, second
minting `c_r4eyaw2` — authenticated hellos always mint via
`makeAuthenticatedIdentity`), and sessionStorage's `fiddle:sync:<room>`
clientId flips on every signed-in reload. `engineTexts` sampling shows
4 × SYNTH·MONO exactly when the reconnect wins the race.

**Almost certainly the June prod data-loss root cause.** Pre-Phase-2b the
outbound `flush:'sync'` watchers were still alive: the same race put a blank
project on a live, gate-open connection, and the watchers synced the blank
state up — matching the incident signature ("recently-edited sessions blanked
to 4×synth, steps gone, bpm survived"). The command architecture no longer
emits the blank state wholesale, so today it is a display bug — **but the
outbound gate is open in the blank state, so any user edit made on top of it
still syncs and clobbers real room data.** Hence P0.

**Related hardening (separate, non-blocking):**
- Authenticated hellos mint a fresh identity every time (ghost identities +
  color churn per reload) — cosmetic.

**Resolution (2026-07-04, branch `fix/p0-reload-snapshot-race`):** three invariant fixes, no structural change — (1) `WsClient.snapshotRequired` (né `forceSnapshotNextHello`) is set-only in `connect()` and cleared exclusively when a snapshot arrives, so mid-handshake reconnects keep requesting the snapshot; (2) `welcome` no longer pre-advances `opIdLastSeen` to `opIdHead` — the watermark advances only on applied content (snapshot / per-op / sync.complete), and a `-1` never-applied sentinel is never sent as `resumeFromOpId`; (3) `SyncSession.connect` defers the first socket open behind `useAuth().ready` and the auth-reconnect watcher ignores flips while the socket has never connected, eliminating the boot-time double handshake. See ARCHITECTURE.md D18. The "Related hardening" item on the server re-minting `clientId` per authenticated hello remains open (cosmetic; tracked under the presence-roster-duplicates entry).

### AudioEngine command-stream params — deferred out of lifecycle Phase 4
**Reported:** 2026-07-02 · **Status:** CLOSED 2026-07-02 — delivered by Phase 5 (feat/phase5-appruntime); AudioEngine subscribes to the CommandBus applied-command stream; watchers + audio-side diffParams deleted. · **Area:** lifecycle-architecture redesign — `packages/client/src/audio/AudioEngine.ts`, `packages/client/src/sync/CommandBus.ts`, `packages/client/src/sync/SyncSession.ts` (buildConnection.applySet), `packages/client/src/composables/useSynth.ts` (sync emitters, bulk ops — file since deleted, see Phase 5)

The [master lifecycle spec](./superpowers/specs/2026-06-27-lifecycle-architecture-design.md)
scoped Phase 4 as *"extract `AudioEngine` + `dispose()`; command-stream params."*
Phase 4 as built ([phase-4 spec](./superpowers/specs/2026-07-02-phase4-audioengine-design.md))
shipped the **structural extraction only** and **kept the Vue reactive slice-watchers**
as the audio param driver. The "AudioEngine subscribes to the command stream, drop the
`diffParams` machinery" half was **deferred**.

**Why deferred (at the time):** the design assumed a Pinia `ProjectStore` where `CommandBus` is the
sole writer. Reality: `project` was a plain reactive singleton and `CommandBus.applySet`
was a bare `setDeep` that emitted **no** stream. The watchers reached audio by observing the
reactive object, so they fired for *every* mutation — including three paths that **bypassed
the bus entirely**: (1) bulk ops (Clear/Shift/Fill, Open/New, preset load), (2) nack
rollback (`Outbox.applyLocal`), (3) `replaceProject` (snapshot load / room reset).
Switching audio to a command-stream subscription was not a relocation — it required
routing all three bypass paths into a new applied-set stream, or audio would silently stop
reacting to them.

**Resolution:** Phase 5 ([spec](./superpowers/specs/2026-07-02-phase5-appruntime-design.md))
made the `CommandBus` the long-lived sole writer (`applySet`/`loadProject`/`applyRollback`
+ a synchronous applied-command stream), turned bulk ops into pure draft-diff-dispatch
(`app/projectOps.ts`), and switched `AudioEngine` to subscribe to that stream instead of
watching the reactive project — all three bypass paths above now route through the bus, and
the `flush:'sync'` watcher/`diffParams` machinery is deleted.

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
