<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <div class="brand">
        <h1>Fiddle Synth</h1>
        <span class="sub-brand">// 4-TRACK SEQUENCER</span>
      </div>
      <button class="close-btn" aria-label="Close navigation" @click="emit('close')">✕</button>
    </div>

    <nav class="nav">
      <RouterLink to="/studio" class="nav-link">Studio</RouterLink>
      <RouterLink to="/account" class="nav-link">Account</RouterLink>
    </nav>

    <div class="identity">
      <button
        v-if="!auth.isAuthenticated.value"
        class="signin-btn"
        @click="auth.signInWithGoogle()"
      >
        Sign in with Google
      </button>
      <RouterLink v-else to="/account" class="self-card">
        <span class="swatch" :style="{ background: selfColor }" />
        <span class="self-handle">{{ selfHandle || 'you' }}</span>
      </RouterLink>
    </div>

    <div class="roster" v-if="others.length">
      <div class="roster-label">In the room</div>
      <div
        v-for="r in others"
        :key="r.clientId"
        class="chip"
        :style="{ background: r.color }"
        :title="r.handle"
      >
        {{ r.handle }}
      </div>
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { roster, selfClientId } from '../sync/presence';
import { useAuth } from '../auth/useAuth';

const emit = defineEmits<{ (e: 'close'): void }>();

const auth = useAuth();

const selfEntry = computed(() =>
  roster.value.find((r) => r.clientId === selfClientId.value) ?? null,
);
const selfHandle = computed(() => selfEntry.value?.handle ?? '');
const selfColor = computed(() => selfEntry.value?.color ?? '#444');
const others = computed(() =>
  roster.value.filter((r) => r.clientId !== selfClientId.value),
);
</script>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 24px 16px;
  height: 100vh;
  box-sizing: border-box;
  background: #161616;
  border-right: 1px solid #222;
  overflow-y: auto;
}
.sidebar-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.brand { display: flex; flex-direction: column; }
.close-btn {
  flex-shrink: 0;
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 6px;
  color: #ddd;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.close-btn:hover {
  color: #fff;
  border-color: #444;
}
.sub-brand {
  font-family: monospace;
  font-size: 0.7rem;
  color: #666;
  font-weight: bold;
  letter-spacing: 0.1em;
  margin-top: 2px;
}
.nav { display: flex; flex-direction: column; gap: 4px; }
.nav-link {
  color: #aaa;
  text-decoration: none;
  font-family: monospace;
  text-transform: uppercase;
  font-size: 0.8rem;
  letter-spacing: 0.05em;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
}
.nav-link:hover { color: #fff; background: #1f1f1f; }
.nav-link.router-link-active {
  color: #00f0ff;
  border-color: #2a2a2a;
  background: #1a1a1a;
}
.identity { margin-top: auto; }
.signin-btn {
  width: 100%;
  font-size: 0.8rem;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #444;
  background: #222;
  color: #ddd;
  cursor: pointer;
}
.self-card {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: #eee;
  padding: 8px 10px;
  border-radius: 6px;
  border: 1px solid #2a2a2a;
  background: #1a1a1a;
}
.swatch { width: 14px; height: 14px; border-radius: 4px; flex-shrink: 0; }
.self-handle { font-size: 0.85rem; font-weight: 600; }
.roster { display: flex; flex-direction: column; gap: 6px; }
.roster-label {
  font-family: monospace;
  font-size: 0.7rem;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.chip {
  padding: 2px 10px;
  border-radius: 12px;
  color: #111;
  font-size: 12px;
  font-weight: 600;
  align-self: flex-start;
}
</style>
