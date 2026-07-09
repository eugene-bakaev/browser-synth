<template>
  <ErrorOverlay />
  <DialogHost />
  <header class="app-bar">
    <div class="app-bar-left">
      <button
        class="hamburger"
        :aria-expanded="sidebarOpen"
        aria-label="Open navigation"
        @click="sidebarOpen = true"
      >
        ☰
      </button>
      <span v-if="showRoomName" class="room-name" :title="roomLabel">{{ roomLabel }}</span>
    </div>
    <!-- Per-page actions (e.g. StudioView's transport) teleport in here, so the
         top bar spans the full width with the hamburger left and page controls right. -->
    <div id="app-bar-actions" class="app-bar-actions"></div>
  </header>
  <div class="app-shell">
    <transition name="backdrop">
      <div v-if="sidebarOpen" class="sidebar-backdrop" @click="sidebarOpen = false" />
    </transition>
    <Sidebar class="sidebar-drawer" :class="{ open: sidebarOpen }" @close="sidebarOpen = false" />
    <main class="app-main">
      <router-view />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { RUNTIME_KEY } from './app/AppRuntime';
import { createSynthContext, SYNTH_CONTEXT } from './app/synthContext';
import { ACTIVE_TRACK_KEY } from './sync/knobSync';
import { reconcileSessionToUrl } from './sync/reconcileSession';
import { getSession } from './sync/sessionsApi';
import ErrorOverlay from './components/ErrorOverlay.vue';
import DialogHost from './components/DialogHost.vue';
import Sidebar from './components/Sidebar.vue';

// The synth context is built exactly once here, in the never-unmounting shell,
// from the page's AppRuntime (provided by main.ts). Its per-context
// currentStep/activeTrackIndex are stable and the runtime's audio/WS survive any
// future navigation.
const runtime = inject(RUNTIME_KEY);
if (!runtime) throw new Error('RUNTIME_KEY not provided — main.ts must provide the AppRuntime');
const synth = createSynthContext(runtime);
provide(SYNTH_CONTEXT, synth);
provide(ACTIVE_TRACK_KEY, synth.activeTrackIndex);

// Room name shown (static) in the app-bar left group. Visible only once loaded
// for the current room; falls back to "Untitled session" for an empty title.
const showRoomName = computed(
  () => synth.currentRoomId.value !== null && synth.sessionName.value !== null,
);
const roomLabel = computed(() => synth.sessionName.value || 'Untitled session');

// The sidebar is an off-canvas drawer, toggled by the hamburger. Closed by
// default. Auto-close after navigating, and on Escape.
const sidebarOpen = ref(false);
const route = useRoute();
const router = useRouter();
watch(() => route.fullPath, () => { sidebarOpen.value = false; });

// Load the room name whenever the connected room changes (covers deep-link,
// lobby join, and room switch — all funnel through currentRoomId). The fetch
// lives here in the shell, not in connectToSession, to keep the sync-critical
// connect path free of HTTP. Race-guarded against a room switch mid-fetch.
watch(
  () => synth.currentRoomId.value,
  async (id) => {
    if (id === null) { synth.sessionName.value = null; return; }
    synth.sessionName.value = null; // clear any stale name during load
    try {
      const m = await getSession(id);
      if (synth.currentRoomId.value === id) synth.sessionName.value = m?.name ?? '';
    } catch {
      // Non-critical: leave null (render nothing) rather than guess a title.
    }
  },
);

// Landing on the lobby means leaving your room (Model A): the lobby is not a
// playback context, and browsing the session list vacates your seat so a room's
// live member count is the same however you arrive — the sidebar Lobby link
// (a memory-router view switch that does NOT itself disconnect), browser Back to
// the roomless URL, or a fatal not_found bounce. Stop the transport and drop any
// active connection. The Back/reconcile and not_found paths disconnect first, so
// the guard skips a redundant leave (and leaveSession resets the project + URL).
watch(() => route.name, (name) => {
  if (name !== 'lobby') return;
  synth.stopPlayback();
  if (synth.currentRoomId.value !== null) synth.leaveSession();
});

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') sidebarOpen.value = false;
}

// Bring the connected session + in-app view into agreement with the room named
// in the address bar. This is the single source of "URL → session" truth, run at
// boot AND on every browser history navigation. The router uses memory history
// (it never reacts to the URL) and the room lives in the URL via raw
// replaceState, so without this the app would only ever read the URL once, at
// load — back/forward would leave the studio showing a stale/empty project that
// no longer matches the address bar. Connection is independent of audio (which
// still boots lazily on first PLAY).
function reconcile(bfcacheRestore = false): void {
  reconcileSessionToUrl({
    currentRoomId: synth.currentRoomId.value,
    connect: (roomId, opts) => synth.connectToSession(roomId, opts),
    leave: () => synth.leaveSession(),
    showStudio: () => { if (route.name !== 'studio') router.replace({ name: 'studio' }); },
    showLobby: () => { if (route.name !== 'lobby') router.replace({ name: 'lobby' }); },
    // Reconcile the focused-track editor with the URL's ?t (same-room Back/Forward
    // between overview and editor; deep-link restore after connect strips ?t).
    applyView: (track) => synth.setFocusedTrack(track),
    bfcacheRestore,
  });
}

// Browser back/forward fires popstate for in-document traversals; pageshow with
// `persisted` fires when the page is restored from the bfcache (its live socket
// was closed while frozen, so that restore must force a reconnect). A normal full
// reload re-runs onMounted instead and fires neither of these (pageshow.persisted
// is false), so there is no double-connect.
function onPopState(): void { reconcile(false); }
function onPageShow(e: PageTransitionEvent): void { if (e.persisted) reconcile(true); }

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('popstate', onPopState);
  window.addEventListener('pageshow', onPageShow);
  reconcile(false);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener('pageshow', onPageShow);
});

// A fatal session.not_found (unknown / pruned session) bounces to the lobby.
watch(
  () => synth.fatalError.value,
  (err) => {
    if (err?.code === 'session.not_found') {
      synth.leaveSession();
      router.replace({ name: 'lobby' });
    }
  },
);
</script>

<!--
  Global design-system / theme styles, unscoped on purpose. Selectors used by
  panel components rendered as children (.module-group, .knob-row, .rack-column*)
  must stay unscoped so they reach across component boundaries; element-level
  theme rules (body, h1) live here too. StudioView.vue's own layout lives in a
  scoped block in that file.

  When adding a selector here: only put it in this block if a child component
  renders an element with that class. Component-local selectors belong in that
  component's own scoped block.
-->
<style>
/* === Design system / theme — global on purpose === */

body {
  margin: 0;
  background: #111;
  color: #eee;
  font-family: 'Outfit', 'Inter', sans-serif;
}
h1 {
  margin: 0;
  font-size: 1.8rem;
  letter-spacing: 0.05em;
  font-weight: 800;
  background: linear-gradient(45deg, #00f0ff, #fb923c);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  text-transform: uppercase;
}

/* Modular panel: shared by every engine panel + drum panel + mixer panel */
.module-group {
  background: #222;
  padding: 15px;
  border-radius: 8px;
  box-sizing: border-box;
  min-width: 0;
  /* Guard rail: content that can't wrap scrolls inside the card instead of
     bleeding over its border. Normal content never triggers it. */
  overflow-x: auto;
}
.module-group h3 {
  margin-top: 0;
  color: #888;
  border-bottom: 1px solid #333;
  padding-bottom: 5px;
  font-family: monospace;
  text-transform: uppercase;
  font-size: 0.9rem;
  letter-spacing: 0.05em;
}

/* Knob layout row — used by every engine/drum/envelope panel.
   Wraps by default. space-evenly spreads leftover width between the knobs;
   when a row is tight the extra space collapses, so the fit guarantee is
   pure cell math: the widest real row (5 knobs × 48px + 4 × 10px gap =
   280px) fits a rack-column at its 320px minimum (290px content). */
.knob-row {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 10px;
  justify-content: space-evenly;
  padding: 10px 0;
}

/* Multi-column rack used inside panel components (SynthPanel, drum panels) */
.rack-columns {
  display: flex;
  flex-direction: row;
  gap: 20px;
  width: 100%;
  flex-wrap: wrap;
  align-items: flex-start;
}
.rack-column {
  flex: 1;
  min-width: 320px; /* must hold a 5-knob row (280px) + 30px card padding */
  display: flex;
  flex-direction: column;
  gap: 15px;
}

/* Mono/Poly mode toggle — rendered by SynthPanel and Synth2Panel */
.synth-mode-selector {
  display: flex;
  gap: 8px;
  width: 100%;
  margin-bottom: 5px;
}
.synth-mode-selector .mode-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 6px 12px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.synth-mode-selector .mode-btn:hover {
  color: #aaa;
  border-color: #444;
}
.synth-mode-selector .mode-btn.active {
  background: #222;
  color: #fff;
  border-color: #555;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}

/* Cross-component interaction: when a panel sits inside the focused engine
   section, hovering it lights up the border in the active track's color.
   Lives in unscoped because .module-group is rendered by child components. */
.engine-section .module-group {
  border: 1px solid #222;
  transition: border-color 0.3s;
}
.engine-section .module-group:hover {
  border-color: var(--track-glow);
}
</style>

<style scoped>
/* Full-width top app-bar: hamburger on the left, page actions (teleported) on
   the right. Sticky so it stays put while the studio content scrolls. */
.app-bar {
  position: sticky;
  top: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  padding: 0 16px;
  box-sizing: border-box;
  background: #111;
  border-bottom: 1px solid #222;
}
.app-bar-actions {
  display: flex;
  align-items: center;
}
.app-bar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0; /* allow the room name to truncate instead of pushing layout */
}
.room-name {
  font-family: monospace;
  font-size: 0.9rem;
  letter-spacing: 0.03em;
  color: #ccc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 36ch;
}

.app-shell {
  min-height: calc(100vh - 56px);
}
.app-main {
  min-width: 0;
  /* auto, not hidden: a systemic overflow must surface as a visible
     scrollbar, never as a silent clip that hides layout breakage. */
  overflow-x: auto;
}

.hamburger {
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #ddd;
  font-size: 1.1rem;
  line-height: 1;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.hamburger:hover {
  color: #fff;
  border-color: #444;
}

/* Off-canvas drawer. The classes land on Sidebar's root <aside> (Vue applies
   the parent scope id to a child component's root), so these style it directly. */
/* The drawer sits ABOVE the top bar (z 50 > bar z 40) so, when open, it covers
   the bar and shows its own close button. The backdrop (z 45) dims everything
   including the bar. */
.sidebar-drawer {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 50;
  width: 240px;
  transform: translateX(-100%);
  transition: transform 0.2s ease;
  will-change: transform;
}
.sidebar-drawer.open {
  transform: translateX(0);
  box-shadow: 4px 0 24px rgba(0, 0, 0, 0.5);
}
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  z-index: 45;
  background: rgba(0, 0, 0, 0.5);
}
.backdrop-enter-active,
.backdrop-leave-active {
  transition: opacity 0.2s ease;
}
.backdrop-enter-from,
.backdrop-leave-to {
  opacity: 0;
}
</style>
