<template>
  <div class="lobby-view">
    <div class="lobby-head">
      <h2>Sessions</h2>
      <button class="btn primary" @click="showCreate = true">+ New session</button>
    </div>

    <p v-if="error" class="error">{{ error }}</p>

    <div v-if="!loading && sessions.length === 0" class="empty">
      <p>No live sessions yet.</p>
      <p>Create one to start jamming — share its link and others can join.</p>
    </div>

    <ul v-else class="session-list">
      <li v-for="s in sessions" :key="s.id" class="session-card" @click="join(s.id)">
        <div class="session-main">
          <span class="session-name">{{ s.name || 'Untitled session' }}</span>
          <span v-if="s.description" class="session-desc">{{ s.description }}</span>
        </div>
        <div class="session-meta">
          <span class="owner-tag">{{ s.isGuestOwned ? 'guest' : 'member' }}</span>
          <span v-if="s.live" class="live-dot" :title="`${s.memberCount} here`">
            ● {{ s.memberCount }}
          </span>
        </div>
      </li>
    </ul>

    <CreateSessionDialog v-if="showCreate" @close="showCreate = false" @created="onCreated" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, inject } from 'vue';
import { useRouter } from 'vue-router';
import { useLobby } from '../composables/useLobby';
import { SYNTH_CONTEXT } from '../sync/synthContext';
import CreateSessionDialog from '../components/CreateSessionDialog.vue';

const router = useRouter();
const synth = inject(SYNTH_CONTEXT)!;

const { sessions, loading, error, startPolling, stopPolling } = useLobby();
const showCreate = ref(false);

onMounted(() => startPolling()); // default interval; pauses while tab hidden
onBeforeUnmount(() => stopPolling());

function join(id: string): void {
  // 'push' adds a browser history entry for the session, so the user's Back
  // button returns here to the lobby instead of stepping out of the app.
  synth.connectToSession(id, { history: 'push' });
  router.push({ name: 'studio' });
}

function onCreated(id: string): void {
  showCreate.value = false;
  join(id);
}
</script>

<style scoped>
.lobby-view { padding: 30px 20px; max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 20px; }
.lobby-head { display: flex; align-items: center; justify-content: space-between; }
.lobby-view h2 { font-family: monospace; text-transform: uppercase; letter-spacing: 0.08em; margin: 0; }
.btn { font-size: 0.85rem; padding: 8px 14px; border-radius: 6px; border: 1px solid #444; background: #222; color: #ddd; cursor: pointer; }
.btn.primary { border-color: #00f0ff; color: #00f0ff; }
.error { color: #FF4136; font-size: 0.85rem; }
.empty { color: #888; border: 1px dashed #333; border-radius: 8px; padding: 24px; text-align: center; }
.session-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 10px; }
.session-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 16px; background: #1a1a1a; border: 1px solid #222; border-radius: 8px; cursor: pointer; transition: border-color 0.2s ease; }
.session-card:hover { border-color: #00f0ff; }
.session-main { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.session-name { font-weight: 600; }
.session-desc { font-size: 0.8rem; color: #888; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-meta { display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
.owner-tag { font-family: monospace; font-size: 0.7rem; color: #666; text-transform: uppercase; }
.live-dot { color: #4ade80; font-size: 0.8rem; font-weight: 600; }
</style>
