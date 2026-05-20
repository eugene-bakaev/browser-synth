<template>
  <div class="synth-container">
    <h1>Fiddle Synth</h1>
    <button @click="startAudio">Start Audio</button>
  </div>
</template>

<script setup lang="ts">
const startAudio = () => {
  console.log('Audio Context Start requested');
}
</script>

<style>
body { margin: 0; background: #1a1a1a; color: #eee; font-family: sans-serif; }
.synth-container { padding: 2rem; }
</style>
