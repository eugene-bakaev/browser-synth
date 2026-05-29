<template>
  <div class="room-bar" v-if="roster.length">
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
</template>

<script setup lang="ts">
// roster / selfClientId are module-scope presence refs, written by the message
// dispatcher (welcome + presence.update). Read directly — no props needed.
import { roster, selfClientId } from '../sync/presence';
</script>

<style scoped>
.room-bar {
  display: flex;
  gap: 8px;
  padding: 4px 12px;
  align-items: center;
}
.chip {
  padding: 2px 10px;
  border-radius: 12px;
  color: #111;
  font-size: 12px;
  font-weight: 600;
  outline: 2px solid transparent;
}
.chip.self {
  outline-color: #fff;
}
</style>
