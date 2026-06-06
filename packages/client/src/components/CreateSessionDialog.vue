<template>
  <BaseModal title="New session" aria-label="Create session" @close="emit('close')">
    <label class="field">
        <span>Name</span>
        <input v-model="name" maxlength="80" placeholder="My jam" @keyup.enter="submit" />
      </label>

      <label class="field">
        <span>Description</span>
        <input v-model="description" maxlength="500" placeholder="optional" />
      </label>

      <div class="field-row">
        <label class="field disabled">
          <span>Max writers</span>
          <input type="number" :value="settings.maxWritableUsers" disabled />
        </label>
        <label class="field disabled">
          <span>Tracks / user</span>
          <input type="number" :value="settings.tracksPerUser" disabled />
        </label>
      </div>
      <p class="hint">Limits are saved but inert this release.</p>

      <div class="seed">
        <span class="seed-label">Start from</span>
        <label><input type="radio" value="default" v-model="seedMode" /> Blank project</label>
        <label><input type="radio" value="import" v-model="seedMode" /> Import .json</label>
        <button v-if="seedMode === 'import'" class="btn" @click="pickFile">
          {{ importedName ? `✓ ${importedName}` : 'Choose file…' }}
        </button>
      </div>

      <p v-if="err" class="error">{{ err }}</p>

      <div class="actions">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn primary" :disabled="busy || !name.trim() || (seedMode === 'import' && !importedProject)" @click="submit">
          {{ busy ? 'Creating…' : 'Create' }}
        </button>
      </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import BaseModal from './BaseModal.vue';
import { DEFAULT_SESSION_SETTINGS, type Project, type CreateSessionBody } from '@fiddle/shared';
import { openProjectFromFile } from '../project';
import { createSession } from '../sync/sessionsApi';
import { guestClientId } from '../sync/clientId';
import { useAuth } from '../auth/useAuth';

const emit = defineEmits<{ (e: 'close'): void; (e: 'created', id: string): void }>();
const auth = useAuth();

const name = ref('');
const description = ref('');
const settings = DEFAULT_SESSION_SETTINGS;
const seedMode = ref<'default' | 'import'>('default');
const importedProject = ref<Project | null>(null);
const importedName = ref<string | null>(null);
const busy = ref(false);
const err = ref<string | null>(null);

async function pickFile(): Promise<void> {
  err.value = null;
  try {
    const project = await openProjectFromFile();
    if (project) {
      importedProject.value = project;
      importedName.value = 'imported project';
    }
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'could not read file';
  }
}

async function submit(): Promise<void> {
  if (!name.value.trim()) return;
  busy.value = true;
  err.value = null;
  try {
    const token = auth.accessToken.value;
    const body: CreateSessionBody = {
      name: name.value.trim(),
      description: description.value.trim(),
      settings,
      seed: seedMode.value === 'import' && importedProject.value ? importedProject.value : 'default',
      // Logged-in creators ignore clientId server-side; guests need it.
      ...(token ? {} : { clientId: guestClientId() }),
    };
    const id = await createSession(body, token);
    emit('created', id);
  } catch (e) {
    err.value = e instanceof Error ? e.message : 'create failed';
  } finally {
    busy.value = false;
  }
}
</script>

<style scoped>
.field { display: flex; flex-direction: column; gap: 6px; font-size: 0.8rem; color: #999; }
.field input { background: #111; border: 1px solid #333; border-radius: 6px; color: #eee; padding: 8px 10px; }
.field.disabled input { opacity: 0.5; }
.field-row { display: flex; gap: 12px; }
.field-row .field { flex: 1; }
.hint { margin: 0; font-size: 0.72rem; color: #666; }
.seed { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 0.82rem; color: #ccc; }
.seed-label { font-family: monospace; font-size: 0.7rem; color: #666; text-transform: uppercase; }
.error { color: #FF4136; font-size: 0.8rem; margin: 0; }
.actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 4px; }
.btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.btn.primary { border-color: #00f0ff; color: #00f0ff; }
.btn:disabled { opacity: 0.5; cursor: default; }
</style>
