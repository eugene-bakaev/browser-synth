<template>
  <BaseModal v-if="open" title="Preset library" aria-label="Preset library" @close="emit('close')">
    <!-- Engine filter chips -->
    <div class="filter-chips">
      <button
        v-for="key in ['all', ...ENGINE_KEYS]"
        :key="key"
        class="chip"
        :class="{ active: filterEngine === key }"
        @click="filterEngine = key as EngineType | 'all'"
      >{{ key.toUpperCase() }}</button>
    </div>

    <!-- Error banner -->
    <p v-if="err" class="error">{{ err }}</p>

    <!-- Loading state -->
    <p v-if="loading" class="hint">Loading…</p>

    <!-- Empty state -->
    <p v-else-if="!loading && grouped.yours.length === 0 && grouped.others.length === 0 && !err" class="hint">
      No presets yet.
    </p>

    <!-- Yours section -->
    <template v-if="grouped.yours.length > 0">
      <h4 class="section-heading">Yours</h4>
      <ul class="preset-list">
        <li v-for="rec in grouped.yours" :key="rec.id" class="preset-row">
          <div class="preset-info">
            <span class="preset-name">{{ rec.name }}</span>
            <span class="engine-badge">{{ rec.engineType }}</span>
            <span class="attribution">you</span>
          </div>
          <div class="row-actions">
            <button
              class="btn"
              :disabled="!canLoad || busyId === rec.id"
              :title="canLoad ? 'Load onto the focused track' : 'Focus a track to load'"
              @click="load(rec)"
            >Load</button>
            <button
              class="btn"
              :disabled="busyId === rec.id"
              @click="rename(rec)"
            >Rename</button>
            <button
              class="btn"
              :disabled="busyId === rec.id"
              @click="togglePublic(rec)"
            >{{ rec.isPublic ? 'Make private' : 'Make public' }}</button>
            <button
              class="btn danger"
              :disabled="busyId === rec.id"
              @click="del(rec)"
            >Delete</button>
          </div>
        </li>
      </ul>
    </template>

    <!-- Public section -->
    <template v-if="grouped.others.length > 0">
      <h4 class="section-heading">Public</h4>
      <ul class="preset-list">
        <li v-for="rec in grouped.others" :key="rec.id" class="preset-row">
          <div class="preset-info">
            <span class="preset-name">{{ rec.name }}</span>
            <span class="engine-badge">{{ rec.engineType }}</span>
            <span class="attribution">{{ rec.ownerUsername ?? 'anon' }}</span>
          </div>
          <div class="row-actions">
            <button
              class="btn"
              :disabled="!canLoad || busyId === rec.id"
              :title="canLoad ? 'Load onto the focused track' : 'Focus a track to load'"
              @click="load(rec)"
            >Load</button>
          </div>
        </li>
      </ul>
    </template>

    <div class="actions">
      <button class="btn" @click="emit('close')">Close</button>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import BaseModal from './BaseModal.vue';
import { listPresets, patchPreset, deletePreset } from '../sync/presetsApi';
import { groupPresets } from '../project/preset-display';
import { useDialog } from '../dialogs/useDialog';
import type { PresetRecord, EngineType } from '@fiddle/shared';

const props = defineProps<{
  open: boolean;
  currentUserId: string | null;
  token?: string;
  canLoad: boolean;
  onLoad: (rec: PresetRecord) => void;
}>();

const emit = defineEmits<{ (e: 'close'): void }>();

const dialog = useDialog();

const ENGINE_KEYS: EngineType[] = [
  'synth', 'synth2', 'kick', 'kick2', 'hat', 'hat2', 'snare', 'snare2', 'clap', 'clap2',
];

const presets = ref<PresetRecord[]>([]);
const loading = ref(false);
const err = ref<string | null>(null);
const filterEngine = ref<EngineType | 'all'>('all');
const busyId = ref<string | null>(null);

async function refetch(): Promise<void> {
  loading.value = true;
  err.value = null;
  try {
    presets.value = await listPresets(
      filterEngine.value === 'all' ? undefined : filterEngine.value,
      props.token,
    );
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'could not load presets';
  } finally {
    loading.value = false;
  }
}

watch(() => props.open, (o) => { if (o) refetch(); }, { immediate: true });
watch(filterEngine, () => { if (props.open) refetch(); });

const grouped = computed(() => groupPresets(presets.value, props.currentUserId));

function load(rec: PresetRecord): void {
  props.onLoad(rec);
  emit('close');
}

async function mutate(id: string, op: () => Promise<void>): Promise<void> {
  busyId.value = id;
  err.value = null;
  try {
    await op();
    await refetch();
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'action failed';
  } finally {
    busyId.value = null;
  }
}

async function rename(rec: PresetRecord): Promise<void> {
  const name = await dialog.prompt({
    title: 'Rename preset',
    message: 'New name',
    defaultValue: rec.name,
  });
  if (!name || !props.token) return;
  await mutate(rec.id, () => patchPreset(rec.id, { name }, props.token!));
}

async function togglePublic(rec: PresetRecord): Promise<void> {
  if (!props.token) return;
  await mutate(rec.id, () => patchPreset(rec.id, { isPublic: !rec.isPublic }, props.token!));
}

async function del(rec: PresetRecord): Promise<void> {
  const ok = await dialog.confirm({
    title: 'Delete preset',
    message: `Delete "${rec.name}"?`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok || !props.token) return;
  await mutate(rec.id, () => deletePreset(rec.id, props.token!));
}
</script>

<style scoped>
.filter-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.chip {
  font-family: monospace;
  font-size: 0.72rem;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #333;
  background: #111;
  color: #999;
  cursor: pointer;
  letter-spacing: 0.05em;
  transition: border-color 0.15s, color 0.15s;
}

.chip:hover {
  border-color: #555;
  color: #ccc;
}

.chip.active {
  border-color: #00f0ff;
  color: #00f0ff;
  background: #0a1a1c;
}

.section-heading {
  margin: 4px 0 2px;
  font-family: monospace;
  font-size: 0.7rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #666;
}

.preset-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.preset-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #2a2a2a;
  background: #111;
}

.preset-row:hover {
  border-color: #333;
}

.preset-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.preset-name {
  color: #ddd;
  font-size: 0.85rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.engine-badge {
  font-family: monospace;
  font-size: 0.68rem;
  padding: 2px 6px;
  border-radius: 3px;
  border: 1px solid #333;
  color: #00f0ff;
  background: #0a1a1c;
  white-space: nowrap;
  flex-shrink: 0;
}

.attribution {
  font-size: 0.72rem;
  color: #666;
  white-space: nowrap;
  flex-shrink: 0;
}

.row-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.hint {
  margin: 0;
  font-size: 0.8rem;
  color: #666;
}

.error {
  color: #FF4136;
  font-size: 0.8rem;
  margin: 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.btn {
  font-size: 0.8rem;
  padding: 5px 10px;
  border-radius: 5px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
  white-space: nowrap;
}

.btn:hover:not(:disabled) {
  border-color: #666;
  color: #eee;
}

.btn:disabled {
  opacity: 0.5;
  cursor: default;
}

.btn.primary {
  border-color: #00f0ff;
  color: #00f0ff;
}

.btn.danger {
  border-color: #883322;
  color: #ff6655;
}

.btn.danger:hover:not(:disabled) {
  border-color: #FF4136;
  color: #FF4136;
}
</style>
