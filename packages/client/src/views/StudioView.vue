<template>
  <!-- Transport lives in the shell's top app-bar (right side). -->
  <Teleport defer to="#app-bar-actions">
    <div class="transport">
      <button @click="togglePlay" :class="{ playing: sequencer.isPlaying }">
        {{ sequencer.isPlaying ? 'STOP' : 'PLAY' }}
      </button>
      <div class="bpm">
        <label>BPM</label>
        <!-- Like the Tracker's length field: v-model a local draft and commit on
             change, so the ~8/sec playback re-renders can't clobber mid-typing. -->
        <input type="number" v-model.number="bpmDraft" min="40" max="240" @change="commitBpm">
      </div>
      <button @click="onNew" title="Discard current project and start fresh">NEW</button>
      <button @click="onSave" title="Save project to a file">SAVE</button>
      <button @click="onOpen" title="Open a project from a file">OPEN</button>
      <button @click="showSettings = true" title="Session settings">SESSION</button>
      <button @click="onLeave" title="Leave this session and return to the lobby">LEAVE</button>
    </div>
  </Teleport>

  <div class="synth-container">
    <!-- Catch-up loader: covers the (blank, just-reset) studio until this
         session's snapshot has been applied locally. -->
    <div v-if="roomLoading" class="session-loader" role="status" aria-live="polite">
      <div class="session-loader-spinner" aria-hidden="true"></div>
      <p>Loading session…</p>
    </div>

    <!-- Track Overview Screen (enabled slots only) -->
    <div v-if="activeTrackIndex === null" class="overview-container">
      <div class="tracks-grid">
        <div
          v-for="entry in enabledTrackEntries"
          :key="entry.index"
          class="track-cell"
        >
          <Tracker
            :steps="entry.track.steps"
            :currentStep="currentStep"
            :title="`Track ${entry.index + 1}`"
            :mixer="entry.track.mixer"
            :color="trackColor(entry.index)"
            :isFocused="false"
            :trackId="entry.index"
            :engineType="getTrackEngineType(entry.index)"
            :mode="trackMode(project.tracks[entry.index])"
            :patternLength="entry.track.patternLength"
            :canRemove="enabledTrackCount > 1"
            @select-track="selectTrack(entry.index)"
            @remove="onRemoveTrack(entry.index)"
            @clear="onClear"
            @shift="onShift"
            @fill="onFill"
            @set-length="onSetLength"
          />
        </div>

        <button
          v-if="enabledTrackCount < TRACK_POOL_SIZE"
          class="add-track-ghost"
          @click="addTrack"
          title="Add a track"
        >+</button>
      </div>
    </div>

    <!-- Focused Single Track Screen -->
    <div v-else class="focused-container">
      <div class="focused-view-header">
        <button class="back-btn" @click="selectTrack(null)">
          ← BACK TO OVERVIEW
        </button>
        <h2 :style="{ color: trackColor(activeTrackIndex) }">
          Editing: Track {{ activeTrackIndex + 1 }} ({{ focusedTrack!.engineType.toUpperCase() }})
        </h2>

        <div class="engine-selector">
          <button
            :class="{ active: focusedTrack!.engineType === 'synth' }"
            @click="focusedTrack!.engineType = 'synth'"
            :style="focusedTrack!.engineType === 'synth' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            SYNTH
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'kick' }"
            @click="focusedTrack!.engineType = 'kick'"
            :style="focusedTrack!.engineType === 'kick' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            KICK
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'hat' }"
            @click="focusedTrack!.engineType = 'hat'"
            :style="focusedTrack!.engineType === 'hat' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            HAT
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'snare' }"
            @click="focusedTrack!.engineType = 'snare'"
            :style="focusedTrack!.engineType === 'snare' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            SNARE
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'clap' }"
            @click="focusedTrack!.engineType = 'clap'"
            :style="focusedTrack!.engineType === 'clap' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            CLAP
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'synth2' }"
            @click="focusedTrack!.engineType = 'synth2'"
            :style="focusedTrack!.engineType === 'synth2' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            SYNTH2
          </button>
          <button
            :class="{ active: focusedTrack!.engineType === 'kick2' }"
            @click="focusedTrack!.engineType = 'kick2'"
            :style="focusedTrack!.engineType === 'kick2' ? { borderColor: trackColor(activeTrackIndex), color: trackColor(activeTrackIndex) } : {}"
          >
            KICK2
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
              :mixer="focusedTrack!.mixer"
              :color="trackColor(activeTrackIndex)"
              :isFocused="true"
              :trackId="activeTrackIndex"
              :engineType="focusedTrack!.engineType"
              :mode="trackMode(focusedTrack!)"
              :patternLength="focusedTrack!.patternLength"
              @clear="onClear"
              @shift="onShift"
              @fill="onFill"
              @set-length="onSetLength"
            />
          </section>

          <section class="engine-section" :style="{ '--track-glow': trackColor(activeTrackIndex) }">
            <template v-if="focusedTrack!.engineType === 'synth'">
              <SynthPanel
                :params="focusedTrack!.engines.synth"
                :waveforms="waveforms"
                :shortestActiveNoteDuration="shortestActiveNoteDuration"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'kick'">
              <KickPanel
                :params="focusedTrack!.engines.kick"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'hat'">
              <HatPanel
                :params="focusedTrack!.engines.hat"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'snare'">
              <SnarePanel
                :params="focusedTrack!.engines.snare"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'clap'">
              <ClapPanel
                :params="focusedTrack!.engines.clap"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'synth2'">
              <Synth2Panel
                :params="focusedTrack!.engines.synth2"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>

            <template v-else-if="focusedTrack!.engineType === 'kick2'">
              <Kick2Panel
                :params="focusedTrack!.engines.kick2"
                :analyser="activeAnalyser"
                :color="trackColor(activeTrackIndex)"
              />
            </template>
          </section>
        </div>
      </div>
    </div>

    <div v-if="showSettings" class="settings-backdrop" @click.self="showSettings = false">
      <div class="settings-dialog" role="dialog" aria-label="Session settings">
        <h3>Session</h3>
        <template v-if="meta">
          <label class="field">
            <span>Name</span>
            <input v-model="metaName" :disabled="!isOwner" maxlength="80" />
          </label>
          <label class="field">
            <span>Description</span>
            <input v-model="metaDesc" :disabled="!isOwner" maxlength="500" />
          </label>
          <p v-if="!isOwner" class="hint">Only the session owner can edit these.</p>
          <p v-if="settingsErr" class="error">{{ settingsErr }}</p>
          <div class="actions">
            <button class="btn" @click="showSettings = false">Close</button>
            <button v-if="isOwner" class="btn primary" :disabled="savingMeta" @click="saveMeta">
              {{ savingMeta ? 'Saving…' : 'Save' }}
            </button>
          </div>
        </template>
        <p v-else class="hint">Loading…</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { SYNTH_CONTEXT } from '../sync/synthContext';
import { trackColor } from '../ui/trackColors';
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
  type ProjectTrack,
} from '../project';
import Tracker from '../components/Tracker.vue';
import SynthPanel from '../components/SynthPanel.vue';
import KickPanel from '../components/KickPanel.vue';
import HatPanel from '../components/HatPanel.vue';
import SnarePanel from '../components/SnarePanel.vue';
import ClapPanel from '../components/ClapPanel.vue';
import Synth2Panel from '../components/Synth2Panel.vue';
import Kick2Panel from '../components/Kick2Panel.vue';
import { useRouter } from 'vue-router';
import { getSession, patchSession, type SessionMeta } from '../sync/sessionsApi';
import { guestClientId } from '../sync/clientId';
import { useAuth } from '../auth/useAuth';
import { useDialog } from '../dialogs/useDialog';

const dialog = useDialog();

const synth = inject(SYNTH_CONTEXT);
if (!synth) throw new Error('SYNTH_CONTEXT not provided');
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
  roomLoading,
  addTrack,
  removeTrack,
  enabledTrackCount,
} = synth;

// Enabled slots paired with their true pool index (used for color, sync paths,
// and the focused view). Disabled slots are filtered out; order is slot order.
const enabledTrackEntries = computed(() =>
  project.tracks
    .map((track, index) => ({ track, index }))
    .filter(e => e.track.enabled),
);

// If the focused track gets disabled (e.g. a remote peer removed it), drop back
// to the overview so we never render a disabled slot's panels.
watch(
  () => (activeTrackIndex.value !== null ? project.tracks[activeTrackIndex.value].enabled : true),
  (stillEnabled) => {
    if (!stillEnabled) selectTrack(null);
  },
);

// BPM editing mirrors the Tracker length field (Tracker.vue): bind a local draft
// and commit on change. A direct v-model against the reactive project.bpm gets
// clobbered by the ~8/sec re-renders during playback, so the field is effectively
// uneditable while the sequence plays. Resync the draft when bpm changes externally
// (remote sync op, or our own clamp).
const bpmDraft = ref(bpm.value);
watch(bpm, (v) => { bpmDraft.value = v; });
const commitBpm = () => {
  const n = Math.round(Number(bpmDraft.value));
  const clamped = Math.max(40, Math.min(240, Number.isFinite(n) && n > 0 ? n : bpm.value));
  bpmDraft.value = clamped; // reflect the clamp in the field
  bpm.value = clamped;
};

// Returns the play mode for a track. Melodic engines (synth, synth2) carry their
// own mode; drum engines don't have a poly layout so we return 'mono' — the
// Tracker ignores the mode prop for non-melodic engines anyway.
function trackMode(t: ProjectTrack): 'mono' | 'poly' {
  if (t.engineType === 'synth') return t.engines.synth.mode;
  if (t.engineType === 'synth2') return t.engines.synth2.mode;
  return 'mono';
}

// Confirm before removing a track — deletion drops the slot's pattern and patch.
const onRemoveTrack = async (index: number) => {
  const ok = await dialog.confirm({
    title: 'Remove track',
    message: `Remove Track ${index + 1}? Its pattern and sound settings will be cleared.`,
    confirmLabel: 'Remove',
    danger: true,
  });
  if (ok) removeTrack(index);
};

const router = useRouter();
const auth = useAuth();

const showSettings = ref(false);
const meta = ref<SessionMeta | null>(null);
const metaName = ref('');
const metaDesc = ref('');
const savingMeta = ref(false);
const settingsErr = ref<string | null>(null);

const isOwner = computed(() => {
  const m = meta.value;
  if (!m) return false;
  const uid = auth.session.value?.user.id ?? null;
  if (m.ownerUserId !== null) return uid === m.ownerUserId;
  return m.ownerClientId !== null && m.ownerClientId === guestClientId();
});

// Load (or refresh) the session metadata whenever the settings panel opens for
// the current room.
watch(showSettings, async (open) => {
  if (!open) return;
  const id = synth!.currentRoomId.value;
  if (!id) return;
  settingsErr.value = null;
  meta.value = null;
  try {
    const m = await getSession(id);
    meta.value = m;
    if (m) { metaName.value = m.name; metaDesc.value = m.description; }
  } catch (e) {
    settingsErr.value = e instanceof Error ? e.message : 'failed to load session';
  }
});

async function saveMeta(): Promise<void> {
  const id = synth!.currentRoomId.value;
  if (!id || !meta.value) return;
  savingMeta.value = true;
  settingsErr.value = null;
  try {
    await patchSession(
      id,
      {
        name: metaName.value.trim(),
        description: metaDesc.value.trim(),
        // Guests authorise with their clientId; logged-in owners via the token.
        clientId: auth.accessToken.value ? undefined : guestClientId(),
      },
      auth.accessToken.value,
    );
    showSettings.value = false;
  } catch (e) {
    settingsErr.value = e instanceof Error ? e.message : 'save failed';
  } finally {
    savingMeta.value = false;
  }
}

function onLeave(): void {
  synth!.leaveSession();
  router.push({ name: 'lobby' });
}

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

const onNew = async () => {
  const ok = await dialog.confirm({
    title: 'New project',
    message: 'Discard current project and start fresh?',
    confirmLabel: 'Discard',
    danger: true,
  });
  if (ok) replaceProject(project, freshProject());
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
    await dialog.alert(`Could not open project: ${e instanceof Error ? e.message : 'unknown error'}`);
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
    await dialog.alert(`Could not load preset: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
};

const onInitPatch = async () => {
  if (activeTrackIndex.value === null) return;
  const ok = await dialog.confirm({
    title: 'Reset patch',
    message: "Reset this track's patch to defaults?",
    confirmLabel: 'Reset',
    danger: true,
  });
  // Re-check: the active track may have changed while the dialog was open.
  if (ok && activeTrackIndex.value !== null) resetEnginePatch(project.tracks[activeTrackIndex.value]);
};
</script>

<style scoped>
/* === StudioView layout — scoped === */

.synth-container {
  position: relative;
  max-width: 1450px;
  margin: 0 auto;
  padding: 30px 20px;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* Session catch-up loader — overlays the studio while the snapshot loads. */
.session-loader {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 18px;
  background: #111;
}
.session-loader p {
  margin: 0;
  font-family: monospace;
  font-size: 0.85rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #888;
}
.session-loader-spinner {
  width: 38px;
  height: 38px;
  border: 3px solid #222;
  border-top-color: #00f0ff;
  border-radius: 50%;
  animation: session-loader-spin 0.8s linear infinite;
}
@keyframes session-loader-spin {
  to { transform: rotate(360deg); }
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
  flex-wrap: nowrap;
  gap: 16px;
  align-items: flex-start;
  width: 100%;
  overflow-x: auto;
  padding-bottom: 12px;
}
.add-track-ghost {
  flex: 0 0 auto;
  align-self: stretch;
  width: 180px;
  min-height: 140px;
  border: 1px dashed #333;
  border-radius: 6px;
  background: #0f0f0f;
  color: #555;
  font-family: monospace;
  font-size: 2rem;
  font-weight: bold;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease, background-color 0.2s ease;
}
.add-track-ghost:hover {
  color: #00f0ff;
  border-color: #00f0ff;
  background: #141414;
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
  /* Matches .tracker-container.focused's width (Tracker.vue) so the VEL
     column's slider track isn't squeezed down to an undraggable sliver. */
  width: 340px;
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

.settings-backdrop { position: fixed; inset: 0; z-index: 60; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; }
.settings-dialog { width: 420px; max-width: calc(100vw - 32px); background: #161616; border: 1px solid #2a2a2a; border-radius: 10px; padding: 22px; display: flex; flex-direction: column; gap: 14px; }
.settings-dialog h3 { margin: 0; font-family: monospace; text-transform: uppercase; letter-spacing: 0.06em; color: #ddd; }
.settings-dialog .field { display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; color: #999; }
.settings-dialog .field input { background: #111; border: 1px solid #333; border-radius: 6px; color: #eee; padding: 8px 10px; }
.settings-dialog .field input:disabled { opacity: 0.5; }
.settings-dialog .hint { margin: 0; font-size: 0.72rem; color: #666; }
.settings-dialog .error { margin: 0; color: #FF4136; font-size: 0.8rem; }
.settings-dialog .actions { display: flex; justify-content: flex-end; gap: 10px; }
.settings-dialog .btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.settings-dialog .btn.primary { border-color: #00f0ff; color: #00f0ff; }
.settings-dialog .btn:disabled { opacity: 0.5; cursor: default; }
</style>
