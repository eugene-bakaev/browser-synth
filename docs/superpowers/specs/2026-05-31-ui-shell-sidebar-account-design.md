# UI Shell, Sidebar & Account Page — Design

**Date:** 2026-05-31
**Status:** Approved (brainstorming)

## Problem

The single `App.vue` (608 lines) crams the brand, the room presence + auth
controls (`RoomBar`), and the transport into one header row. Adding the username
input to `RoomBar` made the header visibly cramped. There is no home for
user-specific account settings, and the username editor lives in interim UI that
should move off the top bar.

## Goals

- Declutter the top of the app by moving navigation and identity/presence into a
  persistent left **sidebar**.
- Add a real **Account page** (personal page) reached via the sidebar, and move
  the username editor there.
- Keep audio playback and the WebSocket sync connection alive across navigation.

## Non-Goals (explicitly out of scope)

- **Server-side project/preset libraries.** "My saved projects" and "My presets"
  need backend persistence that does not exist yet (the roadmap's Supabase
  persistence pivot). Account ships with identity settings only; those sections
  are not built or stubbed.
- **Live session/room switching.** Rooms remain URL/reload-based, exactly as
  today (`resolveRoomIdFromUrl`). The shell is forward-compatible with a future
  `switchRoom`, but no in-app room switching is built here.

## Architecture

`useSynth()` keeps `project`, `sequencer`, the `AudioContext`, and `wsClient` as
**module singletons** created at import, but creates `currentStep` and
`activeTrackIndex` as **local refs on each call** (`useSynth.ts:484-485`).
Nothing tears audio down on unmount (`scope.stop()` runs only in the test-only
`disposeSynth()`). Therefore:

**`useSynth()` must be called exactly once, in a component that never unmounts.**
If a route component called it, navigating away and back would remount it and
reset `activeTrackIndex` (focused track → overview) and re-run the
sequencer→`currentStep` wiring.

- **`App.vue` becomes the shell** — always mounted. It calls `useSynth()` once,
  `provide()`s the result under a typed `SYNTH_CONTEXT` key, keeps the existing
  `provide(ACTIVE_TRACK_KEY, activeTrackIndex)`, and renders
  `<ErrorOverlay />` + `<div class="app-shell"><Sidebar /><main><router-view /></main></div>`.
- **`StudioView.vue`** holds today's `App.vue` body (overview/focused screens,
  transport bar, bottom mixer) and `inject()`s `SYNTH_CONTEXT`. No synth state of
  its own.
- Because audio/sequencer/WS live at module scope and `useSynth()` runs once in
  the never-unmounting shell, **navigation cannot drop audio or the WS
  connection.** `<keep-alive>` is not required for correctness (optional later,
  purely for DOM scroll/focus preservation).

### Routing

Add `vue-router` (not currently a dependency), `createWebHistory`.

| Path       | Component      | Notes                    |
|------------|----------------|--------------------------|
| `/`        | —              | redirect to `/studio`    |
| `/studio`  | `StudioView`   | the synth/sequencer      |
| `/account` | `AccountView`  | the personal page        |

`main.ts` installs the router (`app.use(router)`).

## File Structure

**New**
- `packages/client/src/router/index.ts` — router + routes above.
- `packages/client/src/views/StudioView.vue` — today's `App.vue` body; injects
  `SYNTH_CONTEXT`.
- `packages/client/src/views/AccountView.vue` — the personal page.
- `packages/client/src/components/Sidebar.vue` — nav + identity + roster.
- `packages/client/src/sync/synthContext.ts` — typed
  `SYNTH_CONTEXT: InjectionKey<ReturnType<typeof useSynth>>`. (May instead live
  alongside `ACTIVE_TRACK_KEY` in `knobSync.ts`; implementer's call.)

**Modified**
- `App.vue` — slims to the shell (see Architecture). Its global (unscoped)
  `<style>` design-system block (`.module-group`, `.knob-row`, `.rack-column*`,
  `body`, `h1`) **stays** because child panels depend on it. The scoped
  studio-layout styles **move to `StudioView.vue`**; new shell-grid styles are
  added scoped.
- `main.ts` — `app.use(router)`.
- `auth/useAuth.ts` — widen `SessionLike` to also capture `user.email` and
  `user.user_metadata` (`name`, `avatar_url`) so Account can display them.
  Additive; no behavior change for existing callers (`isAuthenticated`,
  `accessToken`, `setUsername`, etc. unchanged).

**Deleted**
- `components/RoomBar.vue` — retired. Its three concerns split:
  - roster (other users) → `Sidebar`
  - sign-in button + own identity → `Sidebar` identity card
  - username input + Save + status + prefill `watch`/`selfHandle` logic →
    `AccountView`

## Component Detail

### Sidebar (`Sidebar.vue`)

Fixed left rail (~220px), full viewport height, own scroll. Reads `useAuth()` and
the presence singletons (`roster`, `selfClientId`) directly — no props.
Top-to-bottom:

1. **Brand** — `Fiddle Synth` + `// 4-TRACK SEQUENCER` (moved from the header).
2. **Nav** — `<RouterLink>` to **Studio** and **Account**, with active-route
   highlighting. The only entry points to those views.
3. **Identity card** — own presence: color swatch + current handle (from the
   `selfClientId` entry in `roster`). Signed out → **Sign in with Google**
   button. Signed in → handle + an affordance into `/account`.
4. **Roster** — the *other* people in the room (`roster` minus self): color chip
   + handle each. Hidden when alone.

### Account page (`AccountView.vue`)

Gated on auth state.

- **Signed out:** centered prompt "Sign in to manage your account" + Google
  button. Nothing else.
- **Signed in:**
  - **Username** — input + Save + status (`saved` / `taken` / `sign in first`),
    with the prefill `watch`/`selfHandle` logic moved from `RoomBar`. New home of
    the editor.
  - **Identity readout** — Google display name, email, avatar, and the assigned
    presence color swatch.
  - **Sign out** button.

## Data Flow

- Presence: dispatcher in `useSynth.ts` → `roster`/`selfClientId` singletons →
  read by `Sidebar` (and `AccountView` for the self handle prefill).
- Auth: `useAuth()` singleton (session, `setUsername`, `signInWithGoogle`,
  `signOut`) → read/called by `Sidebar` and `AccountView`.
- Synth: `useSynth()` called once in `App.vue` → provided via `SYNTH_CONTEXT` →
  injected by `StudioView`. `ACTIVE_TRACK_KEY` provide unchanged.

## Error Handling

No new error surfaces. `ErrorOverlay` stays mounted at the shell level (outside
the router-view) so fatal synth errors render regardless of route. `setUsername`
keeps its existing taken/not-authed handling, relocated to `AccountView`.

## Testing

No `@vue/test-utils` in the project; convention is to test logic/composables, not
mount `.vue` files. This is a structural UI refactor, so:

- `npm run typecheck && npm test && npm run build` stays green; the existing 320
  tests must not regress. The `useAuth` widening is the only logic change and is
  type-checked.
- Browser verification (user's role): nav switches Studio ⇄ Account without audio
  or WS dropping; roster shows in the sidebar; username save still persists and
  prefills.

No new component-test harness is introduced.

## Migration Notes

- `vue-router` is a new client dependency (npm, not pnpm).
- Deleting `RoomBar.vue` removes its import from `App.vue`; verify no other
  importers (currently only `App.vue`).
- The `App.vue` global `<style>` block must remain unscoped and intact — panels
  rely on it across component boundaries (see the existing comment in `App.vue`).
