<template>
  <div
    class="knob"
    :class="{ 'remote-active': activityColor }"
    :style="activityColor ? { '--activity-color': activityColor } : undefined"
    @dblclick="resetToDefault"
  >
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
import { computed, onBeforeUnmount } from 'vue';
import type { Path, KnobCurve } from '@fiddle/shared';
import { touchedFor } from '../sync/presence';
import { posToValue, valueToPos } from '../ui/knobTaper';
import { formatKnobValue, type KnobFormat } from '../ui/knobFormat';

const props = withDefaults(defineProps<{
  label: string;
  min: number;
  max: number;
  step: number;
  modelValue: number;
  defaultValue?: number;
  format?: KnobFormat;
  labels?: readonly string[];
  curve?: KnobCurve;
  // The sync path this knob writes to, e.g. ['tracks',0,'engines','synth','filterCutoff'].
  // Optional: unsynced knobs (and, until the panels plumb it through, all knobs)
  // leave it undefined and the collaboration affordances stay dormant.
  syncPath?: Path;
}>(), {
  defaultValue: undefined,
  format: undefined,
  labels: undefined,
  curve: 'linear',
  syncPath: undefined,
});

const emit = defineEmits(['update:modelValue', 'gesture-end']);

// When another client just touched this knob's path, render a fading ring in
// their color. Reactive via presence's touchedMap; clears when the touch
// record expires (presence reassigns the map on expiry, retriggering this).
const activityColor = computed(() => {
  if (!props.syncPath) return null;
  return touchedFor(props.syncPath)?.color ?? null;
});

// Generate unique IDs for SVG defs to avoid collisions
const instanceId = Math.random().toString(36).substring(2, 9);
const gradientId = `knob-gradient-${instanceId}`;
const filterId = `knob-filter-${instanceId}`;

const formattedValue = computed(() => formatKnobValue(props.format, props.modelValue, props.labels));

const currentAngle = computed(() => {
  const pos = valueToPos(props.curve, props.modelValue, props.min, props.max);
  return -135 + pos * 270;
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
  const pos = valueToPos(props.curve, props.modelValue, props.min, props.max);
  const endAngle = -135 + pos * 270;
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

// Round to `sig` significant figures — used for tapered knobs, which have no
// value-space `step` to snap to (snapping happens in position space via the drag).
const roundSig = (x: number, sig: number): number => {
  if (x === 0 || !Number.isFinite(x)) return x;
  const mag = Math.pow(10, sig - Math.ceil(Math.log10(Math.abs(x))));
  return Math.round(x * mag) / mag;
};

const onPointerMove = (e: PointerEvent) => {
  const deltaY = startY - e.clientY;
  const isFineTune = e.shiftKey;
  const dragRange = isFineTune ? 800 : 200; // Shift for fine-tuning

  if (props.curve === 'linear') {
    // Unchanged linear path: value-space delta + step snapping.
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
    return;
  }

  // Non-linear: drag in position space so the feel is uniform in perceptual
  // space (equal ratio per pixel on exp). No value-space step; round for storage.
  const startPos = valueToPos(props.curve, startValue, props.min, props.max);
  const newPos = Math.max(0, Math.min(1, startPos + deltaY / dragRange));
  const newValue = roundSig(posToValue(props.curve, newPos, props.min, props.max), 4);

  emit('update:modelValue', newValue);
};

const onPointerUp = () => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
  // Signal end-of-drag so the parent can flush a final value to the outbox
  // immediately (bypassing the 50ms throttle). Wiring is layered in later.
  emit('gesture-end');
};

// If the knob unmounts mid-drag (track switch / panel swap during a drag),
// the window listeners would otherwise survive and keep emitting into the
// unmounted component until the next pointerup anywhere (S2). Removing
// never-added listeners is a no-op, so this is safe outside a drag too.
onBeforeUnmount(() => {
  window.removeEventListener('pointermove', onPointerMove);
  window.removeEventListener('pointerup', onPointerUp);
});

const resetToDefault = () => {
  // No-op without a defaultValue. The old "snapshot modelValue at mount" fallback
  // captured stale values when the same Knob instance got re-bound to a different
  // track via v-model. Every panel now passes the engine's DEFAULT_PARAMS through.
  if (props.defaultValue === undefined) return;
  emit('update:modelValue', props.defaultValue);
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
  border-radius: 50%;
  /* Animate the ring out so a remote touch fades rather than snaps off. */
  transition: box-shadow 500ms ease-out;
}

/* Colored ring around the dial when another client just touched this param. */
.knob.remote-active .knob-dial-container {
  box-shadow: 0 0 0 2px var(--activity-color), 0 0 8px var(--activity-color);
  transition: box-shadow 80ms ease-in;
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
