<template>
  <div class="account-view">
    <h2>Account</h2>

    <div v-if="!auth.isAuthenticated.value" class="signed-out">
      <p>Sign in to manage your account.</p>
      <button class="btn" @click="auth.signInWithGoogle()">Sign in with Google</button>
    </div>

    <template v-else>
      <section class="card">
        <h3>Username</h3>
        <div class="username-row">
          <input
            v-model="draftName"
            class="username-input"
            placeholder="username"
            @keyup.enter="save"
          />
          <button class="btn" :disabled="saving" @click="save">Save</button>
          <span v-if="status" class="status" :class="status">{{ statusText }}</span>
        </div>
      </section>

      <section class="card identity">
        <h3>Identity</h3>
        <div class="identity-row">
          <img v-if="profile.avatarUrl" :src="profile.avatarUrl" class="avatar" alt="" />
          <span class="swatch" :style="{ background: selfColor }" />
          <div class="identity-text">
            <div class="name">{{ profile.name ?? selfHandle ?? '—' }}</div>
            <div class="email">{{ profile.email ?? '' }}</div>
          </div>
        </div>
      </section>

      <button class="btn sign-out" @click="auth.signOut()">Sign out</button>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';

const auth = useAuth();
const profile = auth.userProfile;

const draftName = ref('');
const saving = ref(false);
const status = ref<'' | 'ok' | 'taken'>('');
const statusText = ref('');

// Self entry in the roster (server-resolved handle + assigned color).
const selfEntry = computed(() =>
  roster.value.find((r) => r.clientId === selfClientId.value) ?? null,
);
const selfHandle = computed(() => selfEntry.value?.handle ?? '');
const selfColor = computed(() => selfEntry.value?.color ?? '#444');

// Pre-fill the input with the current handle without clobbering active typing
// (only seed when empty or still equal to the prior handle).
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
.account-view {
  padding: 30px 20px;
  max-width: 720px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.account-view h2 {
  font-family: monospace;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin: 0;
}
.signed-out { display: flex; flex-direction: column; gap: 12px; align-items: flex-start; }
.card {
  background: #1a1a1a;
  border: 1px solid #222;
  border-radius: 8px;
  padding: 18px;
}
.card h3 {
  margin: 0 0 12px;
  color: #888;
  font-family: monospace;
  text-transform: uppercase;
  font-size: 0.85rem;
  letter-spacing: 0.05em;
}
.username-row { display: flex; gap: 8px; align-items: center; }
.username-input {
  font-size: 0.9rem;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #111;
  color: #eee;
  width: 200px;
}
.btn {
  font-size: 0.85rem;
  padding: 6px 14px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: default; }
.sign-out { align-self: flex-start; }
.status { font-size: 0.8rem; }
.status.ok { color: #2ECC40; }
.status.taken { color: #FF4136; }
.identity-row { display: flex; align-items: center; gap: 12px; }
.avatar { width: 40px; height: 40px; border-radius: 50%; }
.swatch { width: 16px; height: 16px; border-radius: 4px; display: inline-block; }
.identity-text .name { font-weight: 600; }
.identity-text .email { font-size: 0.8rem; color: #888; }
</style>
