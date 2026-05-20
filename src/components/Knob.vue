<template>
  <div class="knob">
    <label>{{ label }}</label>
    <div class="control">
      <input 
        type="range" 
        :min="min" 
        :max="max" 
        :step="step" 
        :value="modelValue" 
        @input="$emit('update:modelValue', Number(($event.target as HTMLInputElement).value))"
      >
      <span>{{ modelValue }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
defineProps<{
  label: string;
  min: number;
  max: number;
  step: number;
  modelValue: number;
}>();

defineEmits(['update:modelValue']);
</script>

<style scoped>
.knob { display: flex; flex-direction: column; align-items: center; margin: 5px; }
.control { display: flex; align-items: center; gap: 5px; }
label { font-size: 0.8rem; color: #aaa; }
span { font-family: monospace; min-width: 40px; }
</style>
