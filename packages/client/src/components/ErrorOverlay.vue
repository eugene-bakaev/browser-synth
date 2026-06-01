<template>
  <div v-if="fatalError" class="error-overlay">
    <div class="card">
      <h2>{{ heading }}</h2>
      <p>{{ message }}</p>
      <button v-if="canNewRoom" @click="goToNewRoom">Create a new room</button>
      <button v-else @click="reload">Reload</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSynth } from '../composables/useSynth';

// fatalError is set by the dispatcher when the server sends a fatal `error`
// (then closes the socket). Until then it's null and the overlay is hidden.
const { fatalError } = useSynth();

const heading = computed(() => {
  switch (fatalError.value?.code) {
    case 'room.full':                 return 'Room is full';
    case 'schema.version_mismatch':   return 'Out of date';
    case 'protocol.version_mismatch': return 'Out of date';
    case 'hello.invalid':             return 'Connection error';
    default:                          return 'Disconnected';
  }
});

const message = computed(() => fatalError.value?.message ?? '');
const canNewRoom = computed(() => fatalError.value?.code === 'room.full');

function goToNewRoom() {
  // Navigating to `/` drops the room from the URL and lands on the lobby, where
  // the user can pick or create another session (auto-mint is gone).
  window.location.pathname = '/';
}
function reload() { window.location.reload(); }
</script>

<style scoped>
.error-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.card {
  background: #1a1a1a;
  padding: 24px 32px;
  border-radius: 8px;
  max-width: 400px;
  color: #fff;
}
.card h2 {
  margin: 0 0 8px;
}
.card button {
  margin-top: 16px;
  padding: 8px 16px;
  cursor: pointer;
  background: #00f0ff;
  color: #111;
  border: none;
  border-radius: 4px;
  font-weight: 600;
}
</style>
