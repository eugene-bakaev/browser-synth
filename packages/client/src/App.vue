<template>
  <ErrorOverlay />
  <nav class="temp-nav">
    <RouterLink to="/studio">Studio</RouterLink>
    <RouterLink to="/account">Account</RouterLink>
  </nav>
  <router-view />
</template>

<script setup lang="ts">
import { provide } from 'vue';
import { useSynth } from './composables/useSynth';
import { ACTIVE_TRACK_KEY } from './sync/knobSync';
import { SYNTH_CONTEXT } from './sync/synthContext';
import ErrorOverlay from './components/ErrorOverlay.vue';

// useSynth() is called exactly once here, in the never-unmounting shell, so its
// per-call currentStep/activeTrackIndex are stable and audio/WS (module-scope)
// survive any future navigation.
const synth = useSynth();
provide(SYNTH_CONTEXT, synth);
provide(ACTIVE_TRACK_KEY, synth.activeTrackIndex);
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

/* Knob layout row — used by every engine/drum/envelope panel */
.knob-row {
  display: flex;
  gap: 20px;
  justify-content: space-around;
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
  min-width: 280px;
  display: flex;
  flex-direction: column;
  gap: 15px;
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
.temp-nav {
  display: flex;
  gap: 16px;
  padding: 8px 20px;
}
.temp-nav a { color: #00f0ff; text-decoration: none; font-family: monospace; }
.temp-nav a.router-link-active { text-decoration: underline; }
</style>
