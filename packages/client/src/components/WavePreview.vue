<template>
  <div class="wave-preview">
    <canvas ref="canvasRef"></canvas>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue';
import { renderOscShape, renderLfoShape } from '../engine/synth2/preview/wavePreview';

const props = withDefaults(
  defineProps<{
    kind: 'osc' | 'lfo';
    morph?: number;
    pulseWidth?: number;
    shape?: number;
    color?: string;
  }>(),
  { morph: 0, pulseWidth: 0.5, shape: 0, color: '#00f0ff' },
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
const VPAD = 0.9; // headroom so a full-scale wave isn't clipped at the canvas edge

// Compute (cheap, pure) separated from paint (canvas) so the buffer recomputes
// reactively even where there is no 2D context (tests).
const samples = computed<Float32Array>(() =>
  props.kind === 'lfo' ? renderLfoShape(props.shape) : renderOscShape(props.morph, props.pulseWidth),
);

function resizeCanvas(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (!rect) return;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;
}

function draw(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return; // jsdom / no 2d support → no-op (visible draw verified in browser)
  const { width, height } = canvas;
  if (width === 0 || height === 0) return;
  const dpr = window.devicePixelRatio || 1;

  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = '#1d293d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  ctx.stroke();

  const buf = samples.value;
  if (buf.length === 0) return;
  const span = buf.length > 1 ? buf.length - 1 : 1; // guard divide-by-zero
  ctx.beginPath();
  ctx.lineWidth = 2 * dpr;
  ctx.strokeStyle = props.color;
  ctx.shadowColor = props.color;
  ctx.shadowBlur = 6 * dpr;
  for (let i = 0; i < buf.length; i++) {
    const x = (i / span) * width;
    const y = height / 2 - buf[i] * (height / 2) * VPAD;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

function onResize(): void {
  resizeCanvas();
  draw();
}

// Repaint when the buffer or color changes — static, no animation loop.
watch([samples, () => props.color], draw, { flush: 'post' });

onMounted(() => {
  resizeCanvas();
  draw();
  window.addEventListener('resize', onResize);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
});
</script>

<style scoped>
.wave-preview {
  width: 100%;
  height: 44px;
  margin-top: 6px;
  border: 1px solid #0f172a;
  border-radius: 4px;
  /* border-box: with content-box, 100% + 2px of border overflowed the card
     by 2px (invisible until .module-group gained its overflow guard). */
  box-sizing: border-box;
  overflow: hidden;
  position: relative;
}
.wave-preview canvas {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
}
</style>
