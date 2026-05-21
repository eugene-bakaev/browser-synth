<template>
  <div class="synth-container">
    <header>
      <div class="brand">
        <h1>Fiddle Synth</h1>
        <span class="sub-brand">// 4-TRACK SEQUENCER</span>
      </div>
      <div class="transport">
        <button @click="togglePlay" :class="{ playing: sequencer.isPlaying }">
          {{ sequencer.isPlaying ? 'STOP' : 'PLAY' }}
        </button>
        <div class="bpm">
          <label>BPM</label>
          <input type="number" v-model.number="sequencer.bpm" min="40" max="240">
        </div>
      </div>
    </header>

    <!-- 4-Track Overview Screen -->
    <div v-if="activeTrackIndex === null" class="overview-container">
      <div class="tracks-grid">
        <Tracker 
          v-for="(track, index) in sequencer.tracks"
          :key="track.id"
          :steps="track.steps"
          :currentStep="currentStep"
          :title="track.name"
          :color="TRACK_COLORS[index]"
          :isFocused="false"
          @select-track="selectTrack(index)"
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
          Editing: {{ sequencer.tracks[activeTrackIndex].name }}
        </h2>
      </div>

      <div class="focused-layout">
        <section class="sequencer-section">
          <Tracker 
            :steps="sequencer.tracks[activeTrackIndex].steps"
            :currentStep="currentStep"
            :title="sequencer.tracks[activeTrackIndex].name"
            :color="TRACK_COLORS[activeTrackIndex]"
            :isFocused="true"
          />
        </section>

        <section class="engine-section" :style="{ '--track-glow': TRACK_COLORS[activeTrackIndex] }">
          <OscillatorPanel
            v-model:osc1Type="osc1Type"
            v-model:osc1Coarse="osc1Coarse"
            v-model:osc1Fine="osc1Fine"
            v-model:osc2Type="osc2Type"
            v-model:osc2Coarse="osc2Coarse"
            v-model:osc2Fine="osc2Fine"
            :waveforms="waveforms"
          />

          <MixerPanel
            v-model:osc1Level="osc1Level"
            v-model:osc2Level="osc2Level"
          />

          <FilterPanel
            v-model:cutoff="filterCutoff"
            v-model:res="filterRes"
            v-model:envAmount="filterEnvAmount"
          />

          <EnvelopePanel
            :filterEnv="filterEnv"
            :ampEnv="ampEnv"
          />
        </section>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSynth } from './composables/useSynth';
import Tracker from './components/Tracker.vue';
import OscillatorPanel from './components/OscillatorPanel.vue';
import MixerPanel from './components/MixerPanel.vue';
import FilterPanel from './components/FilterPanel.vue';
import EnvelopePanel from './components/EnvelopePanel.vue';

const {
  sequencer,
  activeTrackIndex,
  currentStep,
  waveforms,
  osc1Type,
  osc2Type,
  osc1Coarse,
  osc1Fine,
  osc2Coarse,
  osc2Fine,
  osc1Level,
  osc2Level,
  filterCutoff,
  filterRes,
  filterEnvAmount,
  filterEnv,
  ampEnv,
  togglePlay,
  selectTrack,
} = useSynth();

const TRACK_COLORS = ['#00f0ff', '#c084fc', '#fb923c', '#4ade80']; // Cyan, Purple, Orange, Green
</script>

<style>
body { 
  margin: 0; 
  background: #111; 
  color: #eee; 
  font-family: 'Outfit', 'Inter', sans-serif; 
}
.synth-container { 
  max-width: 1200px; 
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
/* Hide spin buttons */
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
  gap: 30px;
  align-items: flex-start;
  width: 100%;
}
.sequencer-section {
  flex-shrink: 0;
}
.engine-section { 
  flex: 1; 
  display: flex; 
  flex-direction: column; 
  gap: 15px; 
}

/* Glow indicators on modular panels in focus view */
.engine-section .module-group {
  border: 1px solid #222;
  transition: border-color 0.3s;
}
.engine-section .module-group:hover {
  border-color: var(--track-glow);
}
</style>
