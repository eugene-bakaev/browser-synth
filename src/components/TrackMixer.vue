<template>
  <div class="module-group track-mixer-module">
    <div class="mixer-header">
      <h3>Track Mixer</h3>
      <div class="mixer-status">
        <span class="mixer-status-led" :class="{ active: sequencer.isPlaying }"></span>
        <span class="mixer-status-label">{{ sequencer.isPlaying ? 'ACTIVE' : 'STANDBY' }}</span>
      </div>
    </div>
    
    <div class="channel-strips">
      <div 
        v-for="(track, index) in trackStates" 
        :key="index"
        class="channel-strip"
        :style="{ '--track-color': TRACK_COLORS[index] }"
        :class="{ soloed: track.mixer.soloed, muted: track.mixer.muted }"
      >
        <!-- Strip Header with Label & LED -->
        <div class="strip-header">
          <div class="track-info">
            <span class="track-number">TRK {{ index + 1 }}</span>
            <span class="track-type">{{ track.engineType.toUpperCase() }}</span>
          </div>
          <!-- Pulse LED on note trigger -->
          <div 
            class="trigger-led" 
            :class="{ active: isTrackTriggered(index) }"
          ></div>
        </div>

        <!-- Volume Section -->
        <div class="volume-container">
          <Knob
            label="LEVEL"
            :min="0"
            :max="1"
            :step="0.01"
            :defaultValue="DEFAULT_MIXER_STATE.volume"
            format="percent"
            v-model="track.mixer.volume"
          />
        </div>

        <!-- Buttons Section: Mute & Solo -->
        <div class="mute-solo-controls">
          <button 
            class="btn-mute" 
            :class="{ active: track.mixer.muted }" 
            @click="track.mixer.muted = !track.mixer.muted"
            title="Mute"
          >
            M
          </button>
          <button 
            class="btn-solo" 
            :class="{ active: track.mixer.soloed }" 
            @click="track.mixer.soloed = !track.mixer.soloed"
            title="Solo"
          >
            S
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import { DEFAULT_MIXER_STATE, type TrackState } from '../composables/useSynth';
import type { Track } from '../sequencer/Sequencer';

const props = defineProps<{
  trackStates: TrackState[];
  sequencer: {
    isPlaying: boolean;
    tracks: Track[];
  };
  currentStep: number;
}>();

const TRACK_COLORS = ['#00f0ff', '#c084fc', '#fb923c', '#4ade80'];

// Detect note trigger on current step for active visualization pulse.
// The LED must reflect what's actually audible — a muted step, a muted track,
// or a non-soloed track during solo mode should NOT pulse.
const isTrackTriggered = (index: number) => {
  if (!props.sequencer.isPlaying || props.currentStep < 0) return false;
  const track = props.sequencer.tracks[index];
  if (!track) return false;
  const step = track.steps[props.currentStep];
  if (!step || step.note === null || step.muted) return false;

  const mixer = props.trackStates[index]?.mixer;
  if (!mixer || mixer.muted) return false;

  const anySoloed = props.trackStates.some(ts => ts.mixer?.soloed);
  if (anySoloed && !mixer.soloed) return false;

  return true;
};
</script>

<style scoped>
.track-mixer-module {
  background: rgba(30, 30, 30, 0.7);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
  display: flex;
  flex-direction: column;
  gap: 15px;
  width: 100%;
}

.mixer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  padding-bottom: 10px;
}

.mixer-header h3 {
  margin: 0;
  font-family: 'Outfit', sans-serif;
  font-size: 1.1rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: linear-gradient(90deg, #eee, #888);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.mixer-status {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.2);
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.03);
}

.mixer-status-led {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #333;
  box-shadow: inset 0 1px 1px rgba(0, 0, 0, 0.5);
  transition: all 0.3s ease;
}

.mixer-status-led.active {
  background: #4ade80;
  box-shadow: 0 0 8px #4ade80;
}

.mixer-status-label {
  font-family: monospace;
  font-size: 0.65rem;
  font-weight: bold;
  color: #666;
  letter-spacing: 0.05em;
}

.channel-strips {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 15px;
}

@media (max-width: 768px) {
  .channel-strips {
    grid-template-columns: repeat(2, 1fr);
  }
}

.channel-strip {
  background: rgba(15, 15, 15, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.03);
  border-top: 3px solid var(--track-color);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 15px;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
}

.channel-strip:hover {
  background: rgba(15, 15, 15, 0.75);
  border-color: rgba(255, 255, 255, 0.08);
}

.channel-strip.soloed {
  box-shadow: 0 0 12px rgba(251, 146, 60, 0.1);
  border-color: rgba(251, 146, 60, 0.3);
}

.channel-strip.muted {
  opacity: 0.6;
}

.strip-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  width: 100%;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  padding-bottom: 8px;
}

.track-info {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
}

.track-number {
  font-family: 'Outfit', sans-serif;
  font-size: 0.8rem;
  font-weight: 700;
  color: var(--track-color);
  letter-spacing: 0.02em;
}

.track-type {
  font-family: monospace;
  font-size: 0.6rem;
  color: #666;
  font-weight: bold;
}

.trigger-led {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(0, 0, 0, 0.3);
  transition: background-color 0.05s ease, box-shadow 0.05s ease;
}

.trigger-led.active {
  background: var(--track-color);
  box-shadow: 0 0 10px var(--track-color);
}

.volume-container {
  display: flex;
  justify-content: center;
  align-items: center;
  width: 100%;
  padding: 5px 0;
}

.mute-solo-controls {
  display: flex;
  width: 100%;
  gap: 8px;
  justify-content: center;
}

.mute-solo-controls button {
  flex: 1;
  font-family: 'Outfit', sans-serif;
  font-size: 0.75rem;
  font-weight: bold;
  height: 28px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.4);
  color: #666;
  border: 1px solid rgba(255, 255, 255, 0.05);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  outline: none;
}

.mute-solo-controls button:hover {
  color: #aaa;
  border-color: rgba(255, 255, 255, 0.15);
}

.mute-solo-controls .btn-mute.active {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.25);
  text-shadow: 0 0 4px rgba(239, 68, 68, 0.5);
}

.mute-solo-controls .btn-solo.active {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.4);
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.25);
  text-shadow: 0 0 4px rgba(245, 158, 11, 0.5);
}
</style>
