<template>
  <div class="tracker-container" :style="{ '--track-color': color || '#00f0ff' }" :class="{ focused: isFocused }">
    <div class="tracker-header-bar">
      <div class="tracker-title-row" @click="$emit('select-track')">
        <span class="track-name">{{ title }}</span>
        <div class="title-actions" v-if="!isFocused">
          <span class="title-badge focus-hint">EDIT</span>
          <button
            v-if="canRemove"
            class="title-badge remove-badge"
            title="Remove this track"
            @click.stop="$emit('remove')"
          >DEL</button>
        </div>
      </div>
      <div class="tracker-engine-row">{{ engineLabelText }}</div>
    </div>

    <!-- Operations Toolbar -->
    <div class="tracker-toolbar">
      <button class="tool-btn" @click="$emit('clear', trackId)" title="Clear Track">CLR</button>
      <button class="tool-btn" @click="$emit('shift', { trackId, direction: 'left' })" title="Shift Left">◀</button>
      <button class="tool-btn" @click="$emit('shift', { trackId, direction: 'right' })" title="Shift Right">▶</button>
      <div class="fill-dropdown-container">
        <select class="tool-select" @change="onFillChange" ref="fillSelectRef">
          <option value="" disabled selected>FILL</option>
          <option value="1">ALL</option>
          <option value="2">2ND</option>
          <option value="4">4TH</option>
          <option value="8">8TH</option>
        </select>
      </div>
      <input
        type="number"
        class="tool-len"
        v-model.number="lengthDraft"
        min="1"
        max="64"
        title="Pattern length (steps)"
        @change="commitLength"
      />
    </div>

    <!-- Grid Header -->
    <div
      class="tracker-row tracker-header"
      :class="[
        isMelodic
          ? (isPoly ? 'chord-row' : 'synth-row')
          : 'drum-row',
        { 'with-vel': isFocused && isMelodic }
      ]"
    >
      <div class="col-mute"></div>
      <div class="col-step">STEP</div>
      <template v-if="isMelodic">
        <template v-if="isPoly">
          <div class="col-note">ROOT</div>
          <div class="col-chord-type">CHORD</div>
          <div class="col-oct">OCT</div>
          <div class="col-len">LEN</div>
        </template>
        <template v-else>
          <div class="col-note">NOTE</div>
          <div class="col-oct">OCT</div>
          <div class="col-len">LEN</div>
        </template>
        <div v-if="isFocused" class="col-vel">VEL</div>
      </template>
      <template v-else>
        <div class="col-trig">TRIG</div>
        <div class="col-vel">VELOCITY</div>
      </template>
    </div>
    
    <!-- Step Grid -->
    <div
      class="tracker-steps"
      :class="{ scrolling: patternLength > 16 }"
      ref="stepsEl"
      @focusin="onStepsActive"
      @focusout="onStepsBlur"
      @wheel="markManualScroll"
      @touchmove="markManualScroll"
    >
      <div
        v-for="(step, i) in visibleSteps"
        :key="i"
        class="tracker-row step-row"
        :class="[
          isMelodic
            ? (isPoly ? 'chord-row' : 'synth-row')
            : 'drum-row',
          { active: currentStep >= 0 && (currentStep % patternLength) === i, 'step-muted': step.muted, 'with-vel': isFocused && isMelodic }
        ]"
      >
        <!-- Step Mute Column -->
        <div class="col-mute">
          <button 
            class="mute-btn" 
            :class="{ active: step.muted }" 
            @click="step.muted = !step.muted" 
            title="Mute Step"
          >
            ∅
          </button>
        </div>

        <div class="col-step">{{ i.toString().padStart(2, '0') }}</div>

        <!-- Synth Layout -->
        <template v-if="isMelodic">
          <template v-if="isPoly">
            <div class="col-note">
              <select v-model="step.note" title="Root Note">
                <option :value="null">---</option>
                <option v-for="n in NOTES" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="col-chord-type">
              <select v-model="step.chordType" :disabled="step.note === null" title="Chord Type">
                <option v-for="(_, type) in CHORD_FORMULAS" :key="type" :value="type">{{ type }}</option>
              </select>
            </div>
            <div class="col-oct">
              <StepNumberInput v-model="step.octave" :disabled="step.note === null" :min="0" :max="8" title="Octave" />
            </div>
            <div class="col-len">
              <StepNumberInput v-model="step.length" :disabled="step.note === null" :min="1" :max="16" title="Length (ticks)" />
            </div>
          </template>
          <template v-else>
            <div class="col-note">
              <select v-model="step.note" title="Note">
                <option :value="null">---</option>
                <option v-for="n in NOTES" :key="n" :value="n">{{ n }}</option>
              </select>
            </div>
            <div class="col-oct">
              <StepNumberInput v-model="step.octave" :disabled="step.note === null" :min="0" :max="8" title="Octave" />
            </div>
            <div class="col-len">
              <StepNumberInput v-model="step.length" :disabled="step.note === null" :min="1" :max="16" title="Length (ticks)" />
            </div>
          </template>
          <div v-if="isFocused" class="col-vel">
            <input
              type="range"
              v-model.number="step.velocity"
              min="0"
              max="1"
              step="0.05"
              :disabled="step.note === null"
              title="Velocity"
              class="vel-slider"
            >
            <span class="vel-text">{{ Math.round((step.velocity || 0) * 100) }}%</span>
          </div>
        </template>

        <!-- Drum Layout -->
        <template v-else>
          <div class="col-trig">
            <button 
              class="trig-btn" 
              :class="{ active: step.note !== null }" 
              @click="toggleDrumTrigger(step)"
              title="Toggle Step Trigger"
            ></button>
          </div>
          <div class="col-vel">
            <input 
              type="range" 
              v-model.number="step.velocity" 
              min="0" 
              max="1" 
              step="0.05" 
              :disabled="step.note === null"
              title="Velocity"
              class="vel-slider"
            >
            <span class="vel-text">{{ Math.round((step.velocity || 0) * 100) }}%</span>
          </div>
        </template>
      </div>
    </div>

    <!-- Inline mixer footer — replaces the old bottom Track Mixer strip. Binds
         the same reactive mixer object + sync paths the TrackMixer used. -->
    <div class="tracker-mixer">
      <Knob
        label="LEVEL"
        :min="0"
        :max="1"
        :step="0.01"
        :defaultValue="DEFAULT_MIXER_STATE.volume"
        format="db"
        v-model="mixer.volume"
        :syncPath="['tracks', trackId, 'mixer', 'volume']"
        @gesture-end="endGesture(['tracks', trackId, 'mixer', 'volume'])"
      />
      <div class="tracker-mixer-buttons">
        <button
          class="mix-btn mute"
          :class="{ active: mixer.muted }"
          @click="mixer.muted = !mixer.muted"
          title="Mute"
        >MUTE</button>
        <button
          class="mix-btn solo"
          :class="{ active: mixer.soloed }"
          @click="mixer.soloed = !mixer.soloed"
          title="Solo"
        >SOLO</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { NOTES } from '../utils/notes';
import type { Step } from '../sequencer/Sequencer';
import { CHORD_FORMULAS } from '../utils/chords';
import StepNumberInput from './StepNumberInput.vue';
import { engineLabel } from '../ui/engineLabel';
import Knob from './Knob.vue';
import { DEFAULT_MIXER_STATE } from '../project';
import type { MixerState } from '../project';
import { endGesture } from '../composables/useSynth';

const props = withDefaults(defineProps<{
  steps: Step[];
  currentStep: number;
  title: string;
  color?: string;
  isFocused?: boolean;
  trackId: number;
  engineType: string;
  mode?: 'mono' | 'poly';
  patternLength: number;
  canRemove?: boolean;
  mixer: MixerState;
}>(), {
  mode: 'mono'
});

const emit = defineEmits<{
  (e: 'select-track'): void;
  (e: 'remove'): void;
  (e: 'clear', trackId: number): void;
  (e: 'shift', payload: { trackId: number; direction: 'left' | 'right' }): void;
  (e: 'fill', payload: { trackId: number; interval: number }): void;
  (e: 'set-length', payload: { trackId: number; length: number }): void;
}>();

const fillSelectRef = ref<HTMLSelectElement | null>(null);

// Only the [0, patternLength) window plays/renders. slice() keeps the underlying
// reactive Step references, so in-place edits still write through to `project`.
const visibleSteps = computed(() => props.steps.slice(0, props.patternLength));

// Always-present engine label for the fixed second header row.
const engineLabelText = computed(() => engineLabel(props.engineType, props.mode));

// Melodic engines (synth, synth2) get note/octave/length step entry; everything
// else gets the drum TRIG grid. The poly chord layout is gated on a melodic
// engine whose own mode is poly — StudioView passes each track's own engine mode.
const isMelodic = computed(() => props.engineType === 'synth' || props.engineType === 'synth2');
const isPoly = computed(() => isMelodic.value && props.mode === 'poly');

// The length field is v-model'd to a local draft (not the prop directly) so that the
// ~8/sec re-renders during playback — which re-apply value bindings on every patch —
// can't clobber what the user is mid-typing: the draft tracks the DOM value keystroke
// by keystroke, so the patched value always equals the typed value. Resync from the
// prop when it changes externally (remote sync op, or our own clamp).
const lengthDraft = ref(props.patternLength);
watch(() => props.patternLength, (v) => { lengthDraft.value = v; });

const commitLength = () => {
  const n = Math.round(Number(lengthDraft.value));
  const clamped = Math.max(1, Math.min(64, Number.isFinite(n) && n > 0 ? n : props.patternLength));
  lengthDraft.value = clamped; // reflect the clamp in the field
  emit('set-length', { trackId: props.trackId, length: clamped });
};

// Smart playhead auto-follow. The step list is height-capped at 16 rows; longer
// patterns scroll. We follow the playhead, but suspend while the user is editing a step
// (focus inside the list) or has just scrolled it manually — so it never fights them.
const stepsEl = ref<HTMLElement | null>(null);
const FOLLOW_GRACE_MS = 2000;
let editingInSteps = false;
let lastManualScrollAt = 0;
const onStepsActive = () => { editingInSteps = true; };
const onStepsBlur = () => { editingInSteps = false; };
const markManualScroll = () => { lastManualScrollAt = Date.now(); };

watch(() => props.currentStep, (cs) => {
  if (cs < 0 || props.patternLength <= 16) return; // not playing / no overflow → 0 cost
  if (editingInSteps) return;
  if (Date.now() - lastManualScrollAt < FOLLOW_GRACE_MS) return;
  const el = stepsEl.value;
  if (!el) return;
  const row = el.children[cs % props.patternLength] as HTMLElement | undefined;
  if (!row) return;
  // Contained scrollTop adjustment (never scrollIntoView, which can scroll the window).
  const e = el.getBoundingClientRect();
  const r = row.getBoundingClientRect();
  if (r.top < e.top) el.scrollTop -= (e.top - r.top);
  else if (r.bottom > e.bottom) el.scrollTop += (r.bottom - e.bottom);
});

const onFillChange = (event: Event) => {
  const select = event.target as HTMLSelectElement;
  if (!select.value) return;
  const interval = parseInt(select.value, 10);
  emit('fill', { trackId: props.trackId, interval });
  // Reset select to placeholder
  select.value = "";
};

const toggleDrumTrigger = (step: Step) => {
  if (step.note !== null) {
    step.note = null;
  } else {
    step.note = 'C';
  }
};
</script>

<style scoped>
.tracker-container {
  display: flex;
  flex-direction: column;
  background: #111;
  padding: 10px;
  border-radius: 6px;
  font-family: monospace;
  width: 275px;
  box-sizing: border-box;
  border: 1px solid #222;
  transition: border-color 0.3s, box-shadow 0.3s;
}

.tracker-container.focused {
  /* Wider than the compact 275px rack card: the focused view adds a VEL
     column (see .with-vel grid-template-columns below) that needs real
     room for the range-input track, or it collapses to a few px and the
     slider becomes impossible to drag. */
  width: 340px;
  border-color: var(--track-color);
  box-shadow: 0 0 10px rgba(var(--track-color), 0.15);
}

.tracker-header-bar {
  background: #181818;
  border-bottom: 2px solid var(--track-color);
  border-radius: 4px 4px 0 0;
  margin-bottom: 8px;
}

.tracker-title-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 24px;
  padding: 0 8px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.2s;
}

.tracker-title-row:hover {
  background: #222;
}

.tracker-engine-row {
  height: 16px;
  padding: 0 8px 4px;
  font-size: 0.6rem;
  color: #7a7a7a;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}

.track-name {
  font-weight: bold;
  color: var(--track-color);
  font-size: 0.85rem;
  letter-spacing: 0.05em;
  text-transform: uppercase;
}

.title-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

/* One badge box shared by the EDIT hint and the DEL button so they are
   guaranteed identical in size and baseline — they sit side by side in the
   title bar, not bolted on from outside. */
.title-badge {
  font-family: monospace;
  font-size: 0.65rem;
  font-weight: bold;
  line-height: normal;
  border: 1px solid #333;
  padding: 1px 4px;
  border-radius: 3px;
  color: #666;
  background: transparent;
  transition: color 0.2s, border-color 0.2s, background-color 0.2s;
}

/* EDIT hint lights up in the track colour when the title bar is hovered — but not
   while the DEL button is hovered, since that targets a different action and the
   "click to edit" affordance shouldn't light up then. */
.tracker-title-row:hover:not(:has(.remove-badge:hover)) .focus-hint {
  color: var(--track-color);
  border-color: var(--track-color);
}

.remove-badge {
  color: #888;
  cursor: pointer;
}
.remove-badge:hover {
  color: #fff;
  border-color: #ff4136;
  background: #2a1414;
}

/* Toolbar Styling */
.tracker-toolbar {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.tool-btn {
  background: #181818;
  color: #aaa;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  height: 24px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  cursor: pointer;
  flex: 1;
  transition: background-color 0.2s, color 0.2s, border-color 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tool-btn:hover {
  background: #222;
  color: var(--track-color);
  border-color: var(--track-color);
}

.fill-dropdown-container {
  flex: 2;
  position: relative;
}

.tool-select {
  background: #181818;
  color: #aaa;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  height: 24px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  cursor: pointer;
  width: 100%;
  padding: 0 4px;
  text-align: center;
  text-align-last: center;
  appearance: none;
  -webkit-appearance: none;
  transition: background-color 0.2s, color 0.2s, border-color 0.2s;
}

.tool-select:hover {
  background: #222;
  color: var(--track-color);
  border-color: var(--track-color);
}

.tool-len {
  flex: 1;
  height: 24px;
  min-width: 0;
  background: #181818;
  color: #aaa;
  border: 1px solid #2a2a2a;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.75rem;
  font-weight: bold;
  text-align: center;
  padding: 0 4px;
}
.tool-len:focus {
  outline: none;
  border-color: var(--track-color);
  color: var(--track-color);
}

/* Grid Layouts */
.tracker-row {
  display: grid;
  align-items: center;
  gap: 5px;
}

.tracker-row.synth-row {
  grid-template-columns: 24px 26px 65px 50px 55px;
}

.tracker-row.synth-row.with-vel {
  grid-template-columns: 22px 22px 55px 40px 40px minmax(0, 1fr);
}

/* Non-focused poly layout. Must fit the fixed 275px container (≈253px inner)
   like .synth-row's 240px does — the extra CHORD column means tighter tracks.
   Sum 24+20+42+60+32+32 = 210px + 5 gaps×5 = 235px, comfortably inside. */
.tracker-row.chord-row {
  grid-template-columns: 24px 20px 42px 60px 32px 32px;
}

.tracker-row.chord-row.with-vel {
  grid-template-columns: 22px 18px 40px 50px 28px 28px minmax(0, 1fr);
}

.tracker-row.drum-row {
  grid-template-columns: 24px 26px 55px minmax(0, 1fr);
}

.tracker-header {
  color: #888;
  font-weight: bold;
  padding-bottom: 5px;
  border-bottom: 1px solid #333;
  margin-bottom: 5px;
  text-align: center;
  font-size: 0.75rem;
}

.tracker-header .col-vel {
  display: block;
  text-align: center;
  color: #888;
  font-size: 0.75rem;
  font-weight: bold;
}

.tracker-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  /* Cap at 16 rows (30px row + 2px gap); longer patterns scroll. */
  max-height: calc(16 * 30px + 15 * 2px); /* = 510px */
  overflow-y: auto;
}

/* When a track overflows (>16 steps), bleed the scroll container into the
   panel's right padding (.tracker-container has 10px) so the classic webkit
   bar sits in that gutter, hard against the inner border. The 8px bar consumes
   the negative margin and the 2px padding-right keeps the rows the exact same
   width whether or not the track scrolls (margin = barWidth + padding). */
.tracker-steps.scrolling {
  margin-right: -10px;
  padding-right: 2px;
}

/* Styling ::-webkit-scrollbar also switches Chromium off the OS overlay bar (which
   paints over content) onto a classic bar that occupies its own 8px column. */
.tracker-steps::-webkit-scrollbar {
  width: 8px;
}
.tracker-steps::-webkit-scrollbar-track {
  background: transparent;
}
.tracker-steps::-webkit-scrollbar-thumb {
  background: #333;
  border-radius: 4px;
  border: 2px solid #111; /* inset against the panel bg → ~4px rounded thumb */
}
.tracker-steps::-webkit-scrollbar-thumb:hover {
  background: var(--track-color);
}

.step-row {
  background: #1a1a1a;
  border: 1px solid #282828;
  padding: 2px;
  border-radius: 3px;
  transition: opacity 0.2s;
  /* The steps list is a flex column capped at max-height. Without this, the
     default flex-shrink:1 compresses every row when a track overflows (>16
     steps), so a scrolling 32-step track renders shorter rows than a 16-step
     one. Pin the height and let the container scroll instead. */
  flex-shrink: 0;
}

.step-row.active {
  background: #333;
  border-color: var(--track-color);
}

.step-row.step-muted {
  opacity: 0.4;
}

/* Column Specific Styling */
.col-mute {
  display: flex;
  align-items: center;
  justify-content: center;
}

.mute-btn {
  background: transparent;
  border: none;
  color: #555;
  font-size: 0.85rem;
  cursor: pointer;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  width: 100%;
  border-radius: 3px;
  transition: color 0.2s, background-color 0.2s;
}

.mute-btn:hover {
  background: #2a2a2a;
  color: #ff3b30;
}

.mute-btn.active {
  color: #ff3b30;
  font-weight: bold;
}

.col-step {
  text-align: center;
  color: #555;
  font-size: 0.75rem;
}

.col-trig {
  display: flex;
  align-items: center;
  justify-content: center;
}

.trig-btn {
  background: #000;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  height: 20px;
  width: 20px;
  cursor: pointer;
  margin: 2px auto;
  display: block;
  transition: background-color 0.2s, box-shadow 0.2s, border-color 0.2s;
}

.trig-btn.active {
  background: var(--track-color);
  border-color: var(--track-color);
  box-shadow: 0 0 8px var(--track-color);
}

.trig-btn:hover {
  border-color: var(--track-color);
}

.col-vel {
  display: flex;
  align-items: center;
  gap: 5px;
  justify-content: space-between;
  width: 100%;
}

.vel-slider {
  flex: 1;
  min-width: 0;
  appearance: none;
  background: #000;
  height: 6px;
  border-radius: 3px;
  outline: none;
  border: 1px solid #2a2a2a;
  padding: 0;
  cursor: pointer;
}

.vel-slider::-webkit-slider-thumb {
  appearance: none;
  background: var(--track-color);
  width: 10px;
  height: 10px;
  border-radius: 50%;
  cursor: pointer;
  transition: background-color 0.2s, transform 0.1s;
}

.vel-slider::-webkit-slider-thumb:hover {
  transform: scale(1.2);
}

.vel-slider:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.vel-slider:disabled::-webkit-slider-thumb {
  background: #555;
  cursor: not-allowed;
}

.vel-text {
  font-size: 0.7rem;
  color: #0f0;
  width: 28px;
  text-align: right;
}

.step-row.step-muted .vel-text {
  color: #555;
}

select, input[type="number"] { 
  box-sizing: border-box;
  height: 24px;
  margin: 0;
  background: #000; 
  color: #0f0; 
  border: 1px solid #2a2a2a; 
  font-family: monospace; 
  font-size: 0.85rem;
  width: 100%;
  padding: 0;
  text-align: center;
  text-align-last: center;
  appearance: none;
  -webkit-appearance: none;
  border-radius: 3px;
  display: block;
}

select:focus, input[type="number"]:focus {
  border-color: var(--track-color);
  outline: none;
}

select:disabled, input[type="number"]:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

/* Hide number arrows for cleaner look */
input::-webkit-outer-spin-button, 
input::-webkit-inner-spin-button { 
  -webkit-appearance: none; 
  margin: 0; 
}
input[type=number] {
  -moz-appearance: textfield;
}

/* === Channel-rack: compact sizing for the overview (non-focused) only === */
/* Focused single-track view keeps the original 275px layout untouched. */
.tracker-container:not(.focused) {
  width: 180px;
  padding: 7px;
}

/* Narrowed step-grid columns. One flexible column per track type fills the
   uniform 180px width so there is no dead space: NOTE (mono), CHORD (poly),
   VEL (drums). */
.tracker-container:not(.focused) .tracker-row.synth-row {
  grid-template-columns: 18px 20px minmax(34px, 1fr) 28px 32px;
  gap: 2px;
}
.tracker-container:not(.focused) .tracker-row.chord-row {
  grid-template-columns: 16px 16px 28px minmax(34px, 1fr) 22px 24px;
  gap: 2px;
}
.tracker-container:not(.focused) .tracker-row.drum-row {
  grid-template-columns: 18px 20px 26px minmax(0, 1fr);
  gap: 2px;
}

/* Fixed, identical row height across synth/poly/drum so the playhead row
   highlight lines up horizontally across adjacent columns in the rack. */
.tracker-container:not(.focused) .step-row {
  height: 23px;
  padding: 0 2px;
}

/* Shrink the inputs to fit 1-2 characters. Reaches the StepNumberInput root
   input via Vue's child-root scoping. */
.tracker-container:not(.focused) select,
.tracker-container:not(.focused) input[type="number"] {
  height: 18px;
  font-size: 0.66rem;
}
.tracker-container:not(.focused) .trig-btn {
  height: 16px;
  width: 16px;
}
.tracker-container:not(.focused) .mute-btn {
  height: 18px;
}

/* Reserve a stable scrollbar gutter so a track's row width is identical whether
   it scrolls (>16 steps) or not — a 32-step column is exactly as wide as a
   16-step one, and both stay inside the uniform 180px. This replaces, for the
   compact rack, the conditional `.scrolling` negative-margin gutter (whose
   hardcoded -10px was tuned for the focused view's 10px padding and bled past
   the 7px compact padding, making scrolling tracks render wider). The focused
   single-track view keeps the original `.scrolling` hack untouched.
   `overflow-x: hidden` suppresses the spurious horizontal scrollbar that
   `overflow-y: auto` implies on the tight poly grid. */
.tracker-container:not(.focused) .tracker-steps {
  scrollbar-gutter: stable;
  overflow-x: hidden;
  /* Pin the step area to exactly 16 compact rows so every card in the rack is
     the same height regardless of its step count. Shorter tracks leave a blank
     gap below their last step; the LEVEL/MUTE/SOLO footer then lands at the same
     Y on every card. Longer tracks (>16) still cap here and scroll. Replaces the
     global `max-height`, which let short tracks shrink and float their footer up
     out of line with their neighbours.
     Each row is 25px tall: 23px (.step-row height) + 2px border (content-box, so
     the 1px top/bottom borders add on top). Plus 15 × 2px row gaps. */
  height: calc(16 * 25px + 15 * 2px); /* = 430px */
}
.tracker-container:not(.focused) .tracker-steps.scrolling {
  margin-right: 0;
  padding-right: 0;
}
/* The header row sits outside the scroll container, so reserve the same 8px the
   gutter consumes (see ::-webkit-scrollbar width) to keep its columns aligned
   with the step rows below it. */
.tracker-container:not(.focused) .tracker-header {
  padding-right: 8px;
}

/* === Inline mixer footer === */
.tracker-mixer {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #222;
}

.tracker-mixer-buttons {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
}

.mix-btn {
  height: 20px;
  border-radius: 3px;
  font-family: monospace;
  font-size: 0.62rem;
  font-weight: bold;
  background: rgba(0, 0, 0, 0.4);
  color: #666;
  border: 1px solid rgba(255, 255, 255, 0.06);
  cursor: pointer;
  transition: background-color 0.2s, color 0.2s, border-color 0.2s;
}

.mix-btn:hover {
  color: #aaa;
  border-color: rgba(255, 255, 255, 0.15);
}

.mix-btn.mute.active {
  background: rgba(239, 68, 68, 0.2);
  color: #ef4444;
  border-color: rgba(239, 68, 68, 0.4);
  box-shadow: 0 0 10px rgba(239, 68, 68, 0.25);
}

.mix-btn.solo.active {
  background: rgba(245, 158, 11, 0.2);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.4);
  box-shadow: 0 0 10px rgba(245, 158, 11, 0.25);
}
</style>