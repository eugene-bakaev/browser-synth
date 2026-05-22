<template>
  <div class="visualizer-container">
    <div class="visualizer-header">
      <span class="visualizer-title">Oscilloscope</span>
      <span class="visualizer-status" :style="{ color: color }">Live</span>
    </div>
    <div class="canvas-wrapper">
      <canvas ref="canvasRef"></canvas>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';

const props = withDefaults(
  defineProps<{
    analyser?: AnalyserNode | null;
    color?: string;
  }>(),
  {
    analyser: null,
    color: '#00f0ff'
  }
);

const canvasRef = ref<HTMLCanvasElement | null>(null);
let animationFrameId: number | null = null;
let dataArray: any = null;

const resizeCanvas = () => {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const rect = canvas.parentElement?.getBoundingClientRect();
  if (rect) {
    // Set internal resolution based on CSS size (multiplied by devicePixelRatio for high-DPI displays)
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
  }
};

const draw = () => {
  animationFrameId = requestAnimationFrame(draw);

  const canvas = canvasRef.value;
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const width = canvas.width;
  const height = canvas.height;

  // Clear background
  ctx.fillStyle = '#05070a';
  ctx.fillRect(0, 0, width, height);

  // Draw Grid Lines (Subtle Hardware-style Oscilloscope Grid)
  ctx.strokeStyle = '#121926';
  ctx.lineWidth = 1;
  ctx.shadowBlur = 0; // No glow for grid

  const gridSpacing = 30 * (window.devicePixelRatio || 1);
  
  // Horizontal grid lines
  for (let y = gridSpacing; y < height; y += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  // Vertical grid lines
  for (let x = gridSpacing; x < width; x += gridSpacing) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  // Center axes (slightly brighter)
  ctx.strokeStyle = '#1d293d';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  // Horiz center
  ctx.moveTo(0, height / 2);
  ctx.lineTo(width, height / 2);
  // Vert center
  ctx.moveTo(width / 2, 0);
  ctx.lineTo(width / 2, height);
  ctx.stroke();

  // Get and plot waveform data
  if (props.analyser) {
    const bufferLength = props.analyser.frequencyBinCount;
    if (!dataArray || dataArray.length !== bufferLength) {
      dataArray = new Uint8Array(bufferLength);
    }
    
    props.analyser.getByteTimeDomainData(dataArray);

    ctx.beginPath();
    ctx.lineWidth = 2.5 * (window.devicePixelRatio || 1);
    ctx.strokeStyle = props.color;
    ctx.shadowColor = props.color;
    ctx.shadowBlur = 8 * (window.devicePixelRatio || 1);

    const sliceWidth = width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
      // Norm value from 0-255 to -1.0 to 1.0 (approximately)
      const v = dataArray[i] / 128.0;
      const y = (v * height) / 2;

      if (i === 0) {
        ctx.moveTo(x, y);
      } else {
        ctx.lineTo(x, y);
      }

      x += sliceWidth;
    }

    ctx.lineTo(width, height / 2);
    ctx.stroke();
  } else {
    // Draw flat line at center
    ctx.beginPath();
    ctx.lineWidth = 2 * (window.devicePixelRatio || 1);
    ctx.strokeStyle = props.color;
    ctx.shadowColor = props.color;
    ctx.shadowBlur = 4 * (window.devicePixelRatio || 1);
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }
};

const startAnimation = () => {
  if (animationFrameId === null) {
    draw();
  }
};

const stopAnimation = () => {
  if (animationFrameId !== null) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
};

// Monitor changes in analyser node to restart/stop animations
watch(
  () => props.analyser,
  (newAnalyser) => {
    if (newAnalyser) {
      startAnimation();
    } else {
      // Keep drawing flatline if no analyser
    }
  },
  { immediate: true }
);

onMounted(() => {
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
  startAnimation();
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeCanvas);
  stopAnimation();
});
</script>

<style scoped>
.visualizer-container {
  background: #090d16;
  border: 1px solid #1a2436;
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  height: 150px;
  box-sizing: border-box;
}

.visualizer-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
  font-family: 'Courier New', Courier, monospace;
}

.visualizer-title {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #64748b;
  font-weight: bold;
}

.visualizer-status {
  font-size: 0.7rem;
  text-transform: uppercase;
  font-weight: bold;
  letter-spacing: 1px;
  animation: pulse 1.5s infinite alternate;
}

.canvas-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
  border-radius: 4px;
  border: 1px solid #0f172a;
}

canvas {
  position: absolute;
  top: 0;
  left: 0;
  display: block;
}

@keyframes pulse {
  from { opacity: 0.4; }
  to { opacity: 1; }
}
</style>
