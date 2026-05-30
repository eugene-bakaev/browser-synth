<template>
  <ErrorOverlay />
  <div class="synth-container">
    <header>
      <div class="brand">
        <h1>Fiddle Synth</h1>
        <span class="sub-brand">// 4-TRACK SEQUENCER</span>
      </div>
      <RoomBar />
      <div class="transport">
        <button @click="togglePlay" :class="{ playing: sequencer.isPlaying }">
          {{ sequencer.isPlaying ? 'STOP' : 'PLAY' }}
        </button>
        <div class="bpm">
          <label>BPM</label>
          <input type="number" v-model.number="bpm" min="40" max="240">
        </div>
        <button @click="onNew" title="Discard current project and start fresh">NEW</button>
        <button @click="onSave" title="Save project to a file">SAVE</button>
        <button @click="onOpen" title="Open a project from a file">OPEN</button>
      </div>
    </header>

    <!-- 4-Track Overview Screen -->
    <div v-if="activeTrackIndex === null" class="overview-container">
      <div class="tracks-grid">
        <Tracker
          v-for="(track, index) in project.tracks"
          :key="index"
          :steps="track.steps"
          :currentStep="currentStep"
          :title="`Track ${index + 1} [${getTrackEngineType(index).toUpperCase()}]`"
          :color="TRACK_COLORS[index]"
          :isFocused="false"
          :trackId="index"
          :engineType="getTrackEngineType(index)"
          :mode="project.tracks[index].engines.synth.mode"
          :patternLength="track.patternLength"
          @select-track="selectTrack(index)"
          @clear="onClear"
          @shift="onShift"
          @fill="onFill"
          @set-length="onSetLength"
        />
      </div>
    </div>

    <!-- Focused Single Track Screen -->
    <div v-else class="focused-container">
      <div class="focused-view-header">
        <button class="back-btn" @click="selectTrack(null)">
          ← BACK TO OVERVIEW
        </button>
        <h2 :style="{ color: TRACK_COLORS[activeTrackIndex] }">
          Editing: Track {{ activeTrackIndex + 1 }} ({{ focusedTrack!.engineType.toUpperCase() }})
        </h2>
        
        <div class="engine-selector">
          <button
            :class="{ active: focusedTrack!.engineType === 'synth' }"
            @click="focusedTrack!.engineType = 'synth'"
            :style="focusedTrack!.engineType === 'synth' ? { borderColor: TRACK_COLORS[activeTrackIndex], color: TRACK_COLORS[activeTrackIndex] } : {}"
          >
            SYNTH
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'kick' }"
            @click="focusedTrack!.engineType = 'kick'"
            :style="focusedTrack!.engineType === 'kick' ? { borderColor: TRACK_COLORS[activeTrackIndex], color: TRACK_COLORS[activeTrackIndex] } : {}"
          >
            KICK
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'hat' }"
            @click="focusedTrack!.engineType = 'hat'"
            :style="focusedTrack!.engineType === 'hat' ? { borderColor: TRACK_COLORS[activeTrackIndex], color: TRACK_COLORS[activeTrackIndex] } : {}"
          >
            HAT
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'snare' }"
            @click="focusedTrack!.engineType = 'snare'"
            :style="focusedTrack!.engineType === 'snare' ? { borderColor: TRACK_COLORS[activeTrackIndex], color: TRACK_COLORS[activeTrackIndex] } : {}"
          >
            SNARE
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'clap' }"
            @click="focusedTrack!.engineType = 'clap'"
            :style="focusedTrack!.engineType === 'clap' ? { borderColor: TRACK_COLORS[activeTrackIndex], color: TRACK_COLORS[activeTrackIndex] } : {}"
          >
            CLAP
          </button>
        </div>

        <div class="preset-controls">
          <button @click="onSavePreset" title="Save the current engine + its params as a preset">SAVE PRESET</button>
          <button @click="onLoadPreset" title="Load a preset onto this track">LOAD PRESET</button>
          <button @click="onInitPatch" title="Reset this track's patch to defaults">INIT PATCH</button>
        </div>
      </div>

      <div class="focused-layout">
        <!-- Main Sequencer & Controls Layout -->
        <div class="focused-main-section">
          <section class="sequencer-section">
            <Tracker
              :steps="project.tracks[activeTrackIndex].steps"
              :currentStep="currentStep"
              :title="`Track ${activeTrackIndex + 1}`"
              :color="TRACK_COLORS[activeTrackIndex]"
              :isFocused="true"
              :trackId="activeTrackIndex"
              :engineType="focusedTrack!.engineType"
              :mode="focusedTrack!.engines.synth.mode"
              :patternLength="focusedTrack!.patternLength"
              @clear="onClear"
              @shift="onShift"
              @fill="onFill"
              @set-length="onSetLength"
            />
          </section>

          <section class="engine-section" :style="{ '--track-glow': TRACK_COLORS[activeTrackIndex] }">
            <template v-if="focusedTrack!.engineType === 'synth'">
              <SynthPanel
                :params="focusedTrack!.engines.synth"
                :waveforms="waveforms"
                :shortestActiveNoteDuration="shortestActiveNoteDuration"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>
            
            <template v-else-if="focusedTrack!.engineType === 'kick'">
              <KickPanel
                :params="focusedTrack!.engines.kick"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'hat'">
              <HatPanel
                :params="focusedTrack!.engines.hat"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'snare'">
              <SnarePanel
                :params="focusedTrack!.engines.snare"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'clap'">
              <ClapPanel
                :params="focusedTrack!.engines.clap"
                :analyser="activeAnalyser"
                :color="TRACK_COLORS[activeTrackIndex]"
              />
            </template>
          </section>
        </div>
      </div>
    </div>

    <!-- Track Mixer (Globally visible at the bottom) -->
    <div class="mixer-section">
      <TrackMixer
        :trackStates="project.tracks"
        :sequencer="sequencer"
        :currentStep="currentStep"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, provide } from 'vue';
import { useSynth } from './composables/useSynth';
import { ACTIVE_TRACK_KEY } from './sync/knobSync';
import {
  clearTrack as clearProjectTrack,
  shiftTrack as shiftProjectTrack,
  fillTrack  as fillProjectTrack,
  saveProjectToFile,
  openProjectFromFile,
  replaceProject,
  freshProject,
  makePreset,
  savePresetToFile,
  openPresetFromFile,
  applyPreset,
  resetEnginePatch,
} from './project';
import Tracker from './components/Tracker.vue';
import RoomBar from './components/RoomBar.vue';
import ErrorOverlay from './components/ErrorOverlay.vue';
import SynthPanel from './components/SynthPanel.vue';
import KickPanel from './components/KickPanel.vue';
import HatPanel from './components/HatPanel.vue';
import SnarePanel from './components/SnarePanel.vue';
import ClapPanel from './components/ClapPanel.vue';
import TrackMixer from './components/TrackMixer.vue';

const {
  project,
  trackAnalysers,
  sequencer,
  bpm,
  activeTrackIndex,
  focusedTrack,
  currentStep,
  waveforms,
  shortestActiveNoteDuration,
  togglePlay,
  selectTrack,
  getTrackEngineType,
} = useSynth();

// Hand the focused-track index down to the engine/drum panels so each Knob can
// build its sync path (['tracks', idx, 'engines', <engine>, <field>]) for the
// remote-activity ring + gesture-end flush. See sync/knobSync.ts.
provide(ACTIVE_TRACK_KEY, activeTrackIndex);

const activeAnalyser = computed(() =>
  trackAnalysers.value?.[activeTrackIndex.value ?? 0] ?? null
);

const onClear = (trackId: number) =>
  clearProjectTrack(project.tracks[trackId], project.tracks[trackId].patternLength);
const onShift = ({ trackId, direction }: { trackId: number; direction: 'left' | 'right' }) =>
  shiftProjectTrack(project.tracks[trackId], direction, project.tracks[trackId].patternLength);
const onFill = ({ trackId, interval }: { trackId: number; interval: number }) =>
  fillProjectTrack(project.tracks[trackId], interval, project.tracks[trackId].patternLength);
const onSetLength = ({ trackId, length }: { trackId: number; length: number }) => {
  project.tracks[trackId].patternLength = Math.max(1, Math.min(64, length));
};

const onNew = () => {
  if (confirm('Discard current project and start fresh?')) {
    replaceProject(project, freshProject());
  }
};

const onSave = () => {
  saveProjectToFile(project);
};

const onOpen = async () => {
  try {
    const loaded = await openProjectFromFile();
    if (loaded) replaceProject(project, loaded);
  } catch (e) {
    console.warn('Open failed:', e);
    alert(`Could not open project: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};

const onSavePreset = () => {
  if (activeTrackIndex.value === null) return;
  const track = project.tracks[activeTrackIndex.value];
  const preset = makePreset(track.engineType, track.engines[track.engineType] as any);
  savePresetToFile(preset);
};

const onLoadPreset = async () => {
  if (activeTrackIndex.value === null) return;
  try {
    const preset = await openPresetFromFile();
    if (preset) applyPreset(project.tracks[activeTrackIndex.value], preset);
  } catch (e) {
    console.warn('Load preset failed:', e);
    alert(`Could not load preset: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};

const onInitPatch = () => {
  if (activeTrackIndex.value === null) return;
  if (confirm("Reset this track's patch to defaults?")) {
    resetEnginePatch(project.tracks[activeTrackIndex.value]);
  }
};

const TRACK_COLORS = ['#00f0ff', '#c084fc', '#fb923c', '#4ade80']; // Cyan, Purple, Orange, Green
</script>

<!--
  Two style blocks below — split per A4 audit (docs/CODE_REVIEW.md).

  1. Unscoped block = the global design system. Selectors used by panel
     components rendered as children (.module-group, .knob-row, .rack-column*)
     must stay here so they reach across component boundaries. Element-level
     theme rules (body, header, h1) also live here.

  2. Scoped block = App.vue's own layout. These classes are only referenced
     from App.vue's template; scoping them prevents accidental bleed.

  When adding new selectors:
    - If a child component renders an element with this class → unscoped.
    - If only App.vue's template uses it → scoped.
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
/* === App.vue's own layout — scoped === */

.synth-container {
  max-width: 1450px;
  margin: 0 auto;
  padding: 30px 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}
header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 30px;
  flex-shrink: 0;
  border-bottom: 1px solid #222;
  padding-bottom: 20px;
}
.brand {
  display: flex;
  flex-direction: column;
}
.sub-brand {
  font-family: monospace;
  font-size: 0.75rem;
  color: #666;
  font-weight: bold;
  letter-spacing: 0.1em;
  margin-top: 2px;
}
.transport {
  display: flex;
  gap: 20px;
  align-items: center;
}
.transport button {
  padding: 10px 24px;
  background: #222;
  color: #aaa;
  border: 1px solid #333;
  cursor: pointer;
  font-weight: bold;
  letter-spacing: 0.05em;
  border-radius: 4px;
  transition: all 0.2s ease;
}
.transport button.playing {
  background: #4ade80;
  color: #000;
  border-color: #4ade80;
  box-shadow: 0 0 10px rgba(74, 222, 128, 0.3);
}
.transport button:hover:not(.playing) {
  background: #333;
  color: #fff;
  border-color: #444;
}
.bpm {
  display: flex;
  align-items: center;
  gap: 10px;
  background: #181818;
  border: 1px solid #222;
  padding: 4px 10px;
  border-radius: 4px;
}
.bpm label {
  font-family: monospace;
  font-size: 0.75rem;
  color: #666;
  font-weight: bold;
}
.bpm input {
  background: transparent;
  color: #00f0ff;
  border: none;
  font-family: monospace;
  font-size: 1rem;
  font-weight: bold;
  width: 50px;
  text-align: center;
  outline: none;
}
.bpm input::-webkit-outer-spin-button,
.bpm input::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.bpm input[type=number] {
  -moz-appearance: textfield;
}

/* Overview grid layout */
.overview-container {
  display: flex;
  justify-content: center;
  width: 100%;
}
.tracks-grid {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 20px;
  justify-content: center;
  width: 100%;
}

/* Focused track layout */
.focused-container {
  display: flex;
  flex-direction: column;
  width: 100%;
}
.focused-view-header {
  display: flex;
  align-items: center;
  gap: 20px;
  margin-bottom: 25px;
}
.focused-view-header h2 {
  margin: 0;
  font-family: monospace;
  text-transform: uppercase;
  font-size: 1.1rem;
  letter-spacing: 0.08em;
}
.back-btn {
  background: #181818;
  color: #888;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px 16px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.back-btn:hover {
  color: #fff;
  border-color: #555;
  background: #252525;
}
.focused-layout {
  display: flex;
  flex-direction: column;
  gap: 20px;
  width: 100%;
}
.focused-main-section {
  display: flex;
  flex-direction: row;
  gap: 30px;
  width: 100%;
  align-items: flex-start;
  flex-wrap: wrap;
}
.sequencer-section {
  flex-shrink: 0;
  width: 275px;
}
.engine-section {
  flex: 1;
  min-width: 320px;
}

/* Engine Selector Buttons */
.engine-selector {
  display: flex;
  gap: 10px;
  margin-left: auto;
}
.engine-selector button {
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px 16px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.engine-selector button:hover {
  color: #aaa;
  border-color: #444;
}
.engine-selector button.active {
  background: #222;
  box-shadow: 0 0 10px rgba(0, 0, 0, 0.5);
}

.preset-controls {
  display: flex;
  gap: 10px;
}
.preset-controls button {
  background: #181818;
  color: #888;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 8px 16px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.preset-controls button:hover {
  background: #252525;
  color: #fff;
  border-color: #555;
}

.mixer-section {
  margin-top: 30px;
  flex-shrink: 0;
}
</style>

