<template>
  <div class="knob" @dblclick="resetToDefault">
    <label class="knob-label">{{ label }}</label>
    
    <div 
      class="knob-dial-container"
      @pointerdown="onPointerDown"
      ref="dialRef"
    >
      <svg class="knob-svg" viewBox="0 0 50 50">
        <!-- Background Track -->
        <path 
          :d="backgroundPath" 
          fill="none" 
          stroke="#2d2d2d" 
          stroke-width="4.5" 
          stroke-linecap="round"
        />
        
        <!-- Active Value Track -->
        <path 
          v-if="activePath"
          :d="activePath" 
          fill="none" 
          :stroke="`url(#${gradientId})`" 
          stroke-width="4.5" 
          stroke-linecap="round"
          :filter="`url(#${filterId})`"
        />
        
        <!-- Gradient and Filter Definitions -->
        <defs>
          <linearGradient :id="gradientId" x1="0%" y1="100%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#3b82f6" />
            <stop offset="100%" stop-color="#00f0ff" />
          </linearGradient>
          <filter :id="filterId" x="-30%" y="-30%" width="160%" height="160%">
            <feGaussianBlur stdDeviation="0.8" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        <!-- Inner Rotating Dial -->
        <g :transform="dialTransform">
          <!-- Dial Body -->
          <circle cx="25" cy="25" r="13" fill="#181818" stroke="#3c3c3c" stroke-width="1.5" />
          <!-- Indicator Dot -->
          <circle cx="25" cy="17" r="2" fill="#00f0ff" />
        </g>
      </svg>
    </div>
    
    <span class="knob-value">{{ formattedValue }}</span>
  </div>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue';

const props = withDefaults(defineProps<{
  label: string;
  min: number;
  max: number;
  step: number;
  modelValue: number;
  defaultValue?: number;
  format?: 'hz' | 'ms' | 'percent' | 'cents' | 'octave' | 'ratio';
}>(), {
  defaultValue: undefined,
  format: undefined
});

const emit = defineEmits(['update:modelValue']);

// Generate unique IDs for SVG defs to avoid collisions
const instanceId = Math.random().toString(36).substring(2, 9);
const gradientId = `knob-gradient-${instanceId}`;
const filterId = `knob-filter-${instanceId}`;

// Store initial value on mount to use for reset
const initialValue = ref(props.modelValue);

const formattedValue = computed(() => {
  const val = props.modelValue;
  if (!props.format) return val.toString();
  
  switch (props.format) {
    case 'hz':
      if (val >= 1000) {
        return (val / 1000).toFixed(1) + 'k';
      }
      return Math.round(val) + 'Hz';
    case 'ms':
      if (val < 1.0) {
        return Math.round(val * 1000) + 'ms';
      }
      return val.toFixed(2) + 's';
    case 'percent':
      return Math.round(val * 100) + '%';
    case 'cents': {
      const prefix = val > 0 ? '+' : '';
      return `${prefix}${val}c`;
    }
    case 'octave': {
      const rounded = Number(val.toFixed(1));
      if (rounded === 0) return '0';
      // Arrow shows sweep direction at a glance — ↑ filter opens, ↓ filter closes.
      // Magnitude is in octaves, but the label already implies it; unit text omitted
      // to keep the value cell narrow and stop layout shifts on knob turn.
      return rounded > 0 ? `↑${rounded}` : `↓${Math.abs(rounded)}`;
    }
    case 'ratio':
      return val.toFixed(1);
    default:
      return val.toString();
  }
});

const currentAngle = computed(() => {
  const pct = (props.modelValue - props.min) / (props.max - props.min);
  return -135 + pct * 270;
});

const dialTransform = computed(() => {
  return `rotate(${currentAngle.value} 25 25)`;
});

function polarToCartesian(centerX: number, centerY: number, radius: number, angleInDegrees: number) {
  const angleInRadians = ((angleInDegrees - 90) * Math.PI) / 180.0;
  return {
    x: centerX + radius * Math.cos(angleInRadians),
    y: centerY + radius * Math.sin(angleInRadians)
  };
}

function describeArc(x: number, y: number, radius: number, startAngle: number, endAngle: number) {
  const start = polarToCartesian(x, y, radius, startAngle);
  const end = polarToCartesian(x, y, radius, endAngle);

  if (Math.abs(endAngle - startAngle) < 0.1) {
    return "";
  }

  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";
  
  return [
    "M", start.x, start.y,
    "A", radius, radius, 0, largeArcFlag, 1, end.x, end.y
  ].join(" ");
}

const backgroundPath = computed(() => {
  return describeArc(25, 25, 18, -135, 135);
});

const activePath = computed(() => {
  const pct = (props.modelValue - props.min) / (props.max - props.min);
  const endAngle = -135 + pct * 270;
  return describeArc(25, 25, 18, -135, endAngle);
});

// Drag state
let startY = 0;
let startValue = 0;

const onPointerDown = (e: PointerEvent) => {
  startY = e.clientY;
  startValue = props.modelValue;
  
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  
  e.preventDefault();
};

const onPointerMove = (e: PointerEvent) => {
  const deltaY = startY - e.clientY;
  const isFineTune = e.shiftKey;
  const dragRange = isFineTune ? 800 : 200; // Shift for fine-tuning
  const valueRange = props.max - props.min;
  const valueDelta = (deltaY / dragRange) * valueRange;
  
  let newValue = startValue + valueDelta;
  newValue = Math.max(props.min, Math.min(props.max, newValue));
  
  const stepsCount = Math.round((newValue - props.min) / props.step);
  newValue = props.min + stepsCount * props.step;
  newValue = Math.max(props.min, Math.min(props.max, newValue));
  
  const getPrecision = (num: number) => {
    const parts = num.toString().split('.');
    return parts.length > 1 ? parts[1].length : 0;
  };
  const precision = getPrecision(props.step);
  newValue = parseFloat(newValue.toFixed(precision));
  
  emit('update:modelValue', newValue);
};

const onPointerUp = () => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
};

const resetToDefault = () => {
  const resetVal = props.defaultValue !== undefined ? props.defaultValue : initialValue.value;
  emit('update:modelValue', resetVal);
};
</script>

<style scoped>
.knob {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin: 2px;
  user-select: none;
}

.knob-label {
  font-size: 0.65rem;
  color: #888;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  margin-bottom: 2px;
  text-align: center;
}

.knob-dial-container {
  width: 40px;
  height: 40px;
  cursor: ns-resize;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.knob-svg {
  width: 100%;
  height: 100%;
  display: block;
}

.knob-value {
  font-family: monospace;
  font-size: 0.7rem;
  color: #00f0ff;
  margin-top: 3px;
  background: #000;
  border: 1px solid #222;
  padding: 1px 4px;
  border-radius: 3px;
  /* Fixed width fits every formatter's widest output (~6 chars) so the cell
     doesn't grow as the user drags and shift the surrounding row. */
  width: 48px;
  box-sizing: border-box;
  text-align: center;
}
</style>
