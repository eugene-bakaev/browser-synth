<template>
  <div class="room-bar">
    <div class="roster" v-if="roster.length">
      <div
        v-for="r in roster"
        :key="r.clientId"
        class="chip"
        :class="{ self: r.clientId === selfClientId }"
        :style="{ background: r.color }"
        :title="r.clientId === selfClientId ? `${r.handle} (you)` : r.handle"
      >
        {{ r.handle }}
      </div>
    </div>

    <div class="auth">
      <button v-if="!auth.isAuthenticated.value" class="auth-btn" @click="auth.signInWithGoogle()">
        Sign in with Google
      </button>
      <template v-else>
        <input
          v-model="draftName"
          class="username-input"
          placeholder="username"
          @keyup.enter="save"
        />
        <button class="auth-btn" :disabled="saving" @click="save">Save</button>
        <span v-if="status" class="status" :class="status">{{ statusText }}</span>
        <button class="auth-btn" @click="auth.signOut()">Sign out</button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
// roster / selfClientId are module-scope presence refs, written by the message
// dispatcher (welcome + presence.update). Read directly — no props needed.
import { computed, ref, watch } from 'vue';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';

const auth = useAuth();
const draftName = ref('');
const saving = ref(false);
const status = ref<'' | 'ok' | 'taken'>('');
const statusText = ref('');

// Our current handle as the server resolved it (the saved username, or the
// Google name until one is set). Pre-fill the input with it so a reload shows
// the current name instead of a blank field — but never clobber what the user
// is actively typing (only seed when empty or still equal to the prior handle).
const selfHandle = computed(
  () => roster.value.find((r) => r.clientId === selfClientId.value)?.handle ?? '',
);
watch(
  selfHandle,
  (next, prev) => {
    if (!next) return;
    if (draftName.value === '' || draftName.value === prev) draftName.value = next;
  },
  { immediate: true },
);

async function save() {
  if (!draftName.value.trim()) return;
  saving.value = true;
  status.value = '';
  try {
    const res = await auth.setUsername(draftName.value.trim());
    if (res.ok) {
      status.value = 'ok';
      statusText.value = 'saved';
    } else {
      status.value = 'taken';
      statusText.value = res.reason === 'taken' ? 'taken' : 'sign in first';
    }
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.room-bar {
  display: flex;
  gap: 12px;
  padding: 4px 12px;
  align-items: center;
  justify-content: space-between;
}
.roster { display: flex; gap: 8px; align-items: center; }
.chip {
  padding: 2px 10px;
  border-radius: 12px;
  color: #111;
  font-size: 12px;
  font-weight: 600;
  outline: 2px solid transparent;
}
.chip.self { outline-color: #fff; }
.auth { display: flex; gap: 6px; align-items: center; }
.auth-btn {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
}
.auth-btn:disabled { opacity: 0.5; cursor: default; }
.username-input {
  font-size: 12px;
  padding: 2px 6px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #111;
  color: #eee;
  width: 110px;
}
.status { font-size: 11px; }
.status.ok { color: #2ECC40; }
.status.taken { color: #FF4136; }
</style>
