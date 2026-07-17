<template>
  <div class="rack-columns">
    <!-- Mono/Poly toggle -->
    <div class="synth-mode-selector">
      <button
        type="button"
        class="mode-btn"
        :class="{ active: params.mode === 'mono' }"
        @click="ks.set('mode', 'mono')"
      >
        MONO
      </button>
      <button
        type="button"
        class="mode-btn"
        :class="{ active: params.mode === 'poly' }"
        @click="ks.set('mode', 'poly')"
      >
        POLY
      </button>
      <div class="glide-control">
        <Knob v-if="!params.glide.sync" :label="knobLabel('glide.time')" :min="0.001" :max="2" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.glide.time" :modelValue="params.glide.time" @update:modelValue="ks.set(['glide', 'time'], $event)" :syncPath="ks.pathFor(['glide', 'time'])" @gesture-end="ks.end(['glide', 'time'])" />
        <Knob v-else :label="knobLabel('glide.time')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.glide.div)" :modelValue="envDivisionLabelToIndex(params.glide.div)" @update:modelValue="ks.set(['glide', 'div'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['glide', 'div'])" @gesture-end="ks.end(['glide', 'div'])" />
        <button type="button" class="glide-sync-btn" :class="{ active: params.glide.sync }" @click="ks.set(['glide', 'sync'], !params.glide.sync)">SYNC</button>
      </div>
    </div>

    <!-- Column 1: Oscillator 1 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 1</h3>
        <WavePreview kind="osc" :morph="params.osc1.morph" :pulseWidth="params.osc1.pulseWidth" :color="color" />
        <div class="knob-row">
          <Knob :label="knobLabel('osc1.morph')" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc1.morph" :modelValue="params.osc1.morph" @update:modelValue="ks.set(['osc1', 'morph'], $event)" :syncPath="ks.pathFor(['osc1', 'morph'])" @gesture-end="ks.end(['osc1', 'morph'])" />
          <Knob :label="knobLabel('osc1.pulseWidth')" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc1.pulseWidth" :modelValue="params.osc1.pulseWidth" @update:modelValue="ks.set(['osc1', 'pulseWidth'], $event)" :syncPath="ks.pathFor(['osc1', 'pulseWidth'])" @gesture-end="ks.end(['osc1', 'pulseWidth'])" />
          <Knob :label="knobLabel('osc1.coarse')" :min="-36" :max="36" :step="12" format="octaveSwitch" :defaultValue="DEFAULTS.osc1.coarse" :modelValue="params.osc1.coarse" @update:modelValue="ks.set(['osc1', 'coarse'], $event)" :syncPath="ks.pathFor(['osc1', 'coarse'])" @gesture-end="ks.end(['osc1', 'coarse'])" />
          <Knob :label="knobLabel('osc1.fine')" :min="-1200" :max="1200" :step="1" format="cents" :defaultValue="DEFAULTS.osc1.fine" :modelValue="params.osc1.fine" @update:modelValue="ks.set(['osc1', 'fine'], $event)" :syncPath="ks.pathFor(['osc1', 'fine'])" @gesture-end="ks.end(['osc1', 'fine'])" />
          <Knob :label="knobLabel('osc1.level')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc1.level" :modelValue="params.osc1.level" @update:modelValue="ks.set(['osc1', 'level'], $event)" :syncPath="ks.pathFor(['osc1', 'level'])" @gesture-end="ks.end(['osc1', 'level'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>ENV 1 · {{ SYNTH2_ENV_ROLES.env1.toUpperCase() }}</h3>
        <div class="knob-row env-knob-row">
          <Knob v-if="!params.env1.sync" :label="knobLabel('env1.a')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env1.a" :modelValue="params.env1.a" @update:modelValue="ks.set(['env1', 'a'], $event)" :syncPath="ks.pathFor(['env1', 'a'])" @gesture-end="ks.end(['env1', 'a'])" />
          <Knob v-else :label="knobLabel('env1.a')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env1.aDiv)" :modelValue="envDivisionLabelToIndex(params.env1.aDiv)" @update:modelValue="ks.set(['env1', 'aDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'aDiv'])" @gesture-end="ks.end(['env1', 'aDiv'])" />
          <Knob v-if="!params.env1.sync" :label="knobLabel('env1.d')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env1.d" :modelValue="params.env1.d" @update:modelValue="ks.set(['env1', 'd'], $event)" :syncPath="ks.pathFor(['env1', 'd'])" @gesture-end="ks.end(['env1', 'd'])" />
          <Knob v-else :label="knobLabel('env1.d')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env1.dDiv)" :modelValue="envDivisionLabelToIndex(params.env1.dDiv)" @update:modelValue="ks.set(['env1', 'dDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'dDiv'])" @gesture-end="ks.end(['env1', 'dDiv'])" />
          <Knob :label="knobLabel('env1.s')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env1.s" :modelValue="params.env1.s" @update:modelValue="ks.set(['env1', 's'], $event)" :syncPath="ks.pathFor(['env1', 's'])" @gesture-end="ks.end(['env1', 's'])" />
          <Knob v-if="!params.env1.sync" :label="knobLabel('env1.r')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env1.r" :modelValue="params.env1.r" @update:modelValue="ks.set(['env1', 'r'], $event)" :syncPath="ks.pathFor(['env1', 'r'])" @gesture-end="ks.end(['env1', 'r'])" />
          <Knob v-else :label="knobLabel('env1.r')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env1.rDiv)" :modelValue="envDivisionLabelToIndex(params.env1.rDiv)" @update:modelValue="ks.set(['env1', 'rDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env1', 'rDiv'])" @gesture-end="ks.end(['env1', 'rDiv'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env1.loop }" @click="ks.set(['env1', 'loop'], !params.env1.loop)">LOOP</button>
        <button type="button" class="env-sync-btn" :class="{ active: params.env1.sync }" @click="ks.set(['env1', 'sync'], !params.env1.sync)">SYNC</button>
      </div>
    </div>

    <!-- Column 2: Oscillator 2 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 2</h3>
        <WavePreview kind="osc" :morph="params.osc2.morph" :pulseWidth="params.osc2.pulseWidth" :color="color" />
        <div class="knob-row">
          <Knob :label="knobLabel('osc2.morph')" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc2.morph" :modelValue="params.osc2.morph" @update:modelValue="ks.set(['osc2', 'morph'], $event)" :syncPath="ks.pathFor(['osc2', 'morph'])" @gesture-end="ks.end(['osc2', 'morph'])" />
          <Knob :label="knobLabel('osc2.pulseWidth')" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc2.pulseWidth" :modelValue="params.osc2.pulseWidth" @update:modelValue="ks.set(['osc2', 'pulseWidth'], $event)" :syncPath="ks.pathFor(['osc2', 'pulseWidth'])" @gesture-end="ks.end(['osc2', 'pulseWidth'])" />
          <Knob :label="knobLabel('osc2.coarse')" :min="-36" :max="36" :step="12" format="octaveSwitch" :defaultValue="DEFAULTS.osc2.coarse" :modelValue="params.osc2.coarse" @update:modelValue="ks.set(['osc2', 'coarse'], $event)" :syncPath="ks.pathFor(['osc2', 'coarse'])" @gesture-end="ks.end(['osc2', 'coarse'])" />
          <Knob :label="knobLabel('osc2.fine')" :min="-1200" :max="1200" :step="1" format="cents" :defaultValue="DEFAULTS.osc2.fine" :modelValue="params.osc2.fine" @update:modelValue="ks.set(['osc2', 'fine'], $event)" :syncPath="ks.pathFor(['osc2', 'fine'])" @gesture-end="ks.end(['osc2', 'fine'])" />
          <Knob :label="knobLabel('osc2.level')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc2.level" :modelValue="params.osc2.level" @update:modelValue="ks.set(['osc2', 'level'], $event)" :syncPath="ks.pathFor(['osc2', 'level'])" @gesture-end="ks.end(['osc2', 'level'])" />
        </div>
        <button
          type="button"
          class="sync-btn"
          :class="{ active: params.osc2.sync }"
          @click="ks.set(['osc2', 'sync'], !params.osc2.sync)"
        >
          SYNC
        </button>
      </div>
    </div>

    <!-- Column 3: Oscillator 3 -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>OSC 3</h3>
        <WavePreview kind="osc" :morph="params.osc3.morph" :pulseWidth="params.osc3.pulseWidth" :color="color" />
        <div class="knob-row">
          <Knob :label="knobLabel('osc3.morph')" :min="0" :max="3" :step="0.01" :defaultValue="DEFAULTS.osc3.morph" :modelValue="params.osc3.morph" @update:modelValue="ks.set(['osc3', 'morph'], $event)" :syncPath="ks.pathFor(['osc3', 'morph'])" @gesture-end="ks.end(['osc3', 'morph'])" />
          <Knob :label="knobLabel('osc3.pulseWidth')" :min="0.05" :max="0.95" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc3.pulseWidth" :modelValue="params.osc3.pulseWidth" @update:modelValue="ks.set(['osc3', 'pulseWidth'], $event)" :syncPath="ks.pathFor(['osc3', 'pulseWidth'])" @gesture-end="ks.end(['osc3', 'pulseWidth'])" />
          <Knob :label="knobLabel('osc3.coarse')" :min="-36" :max="36" :step="12" format="octaveSwitch" :defaultValue="DEFAULTS.osc3.coarse" :modelValue="params.osc3.coarse" @update:modelValue="ks.set(['osc3', 'coarse'], $event)" :syncPath="ks.pathFor(['osc3', 'coarse'])" @gesture-end="ks.end(['osc3', 'coarse'])" />
          <Knob :label="knobLabel('osc3.fine')" :min="-1200" :max="1200" :step="1" format="cents" :defaultValue="DEFAULTS.osc3.fine" :modelValue="params.osc3.fine" @update:modelValue="ks.set(['osc3', 'fine'], $event)" :syncPath="ks.pathFor(['osc3', 'fine'])" @gesture-end="ks.end(['osc3', 'fine'])" />
          <Knob :label="knobLabel('osc3.level')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.osc3.level" :modelValue="params.osc3.level" @update:modelValue="ks.set(['osc3', 'level'], $event)" :syncPath="ks.pathFor(['osc3', 'level'])" @gesture-end="ks.end(['osc3', 'level'])" />
        </div>
        <button
          type="button"
          class="sync-btn"
          :class="{ active: params.osc3.sync }"
          @click="ks.set(['osc3', 'sync'], !params.osc3.sync)"
        >
          SYNC
        </button>
      </div>
    </div>

    <!-- Column 4: Noise + FM -->
    <div class="rack-column">
      <div class="module-group">
        <h3>NOISE</h3>
        <div class="knob-row">
          <Knob :label="knobLabel('noise.level')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.noise.level" :modelValue="params.noise.level" @update:modelValue="ks.set(['noise', 'level'], $event)" :syncPath="ks.pathFor(['noise', 'level'])" @gesture-end="ks.end(['noise', 'level'])" />
          <Knob :label="knobLabel('noise.color')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.noise.color" :modelValue="params.noise.color" @update:modelValue="ks.set(['noise', 'color'], $event)" :syncPath="ks.pathFor(['noise', 'color'])" @gesture-end="ks.end(['noise', 'color'])" />
        </div>
      </div>
      <div class="module-group">
        <h3>FM</h3>
        <div class="knob-row">
          <Knob :label="knobLabel('fm.osc2')" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.fm.osc2" :modelValue="params.fm.osc2" @update:modelValue="ks.set(['fm', 'osc2'], $event)" :syncPath="ks.pathFor(['fm', 'osc2'])" @gesture-end="ks.end(['fm', 'osc2'])" />
          <Knob :label="knobLabel('fm.osc3')" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.fm.osc3" :modelValue="params.fm.osc3" @update:modelValue="ks.set(['fm', 'osc3'], $event)" :syncPath="ks.pathFor(['fm', 'osc3'])" @gesture-end="ks.end(['fm', 'osc3'])" />
        </div>
      </div>
    </div>

    <!-- Column 5: Filter -->
    <div class="rack-column">
      <div class="module-group synth2-panel">
        <h3>FILTER</h3>
        <div class="filter-model-selector">
          <button type="button" class="filter-model-btn to-classic" :class="{ active: params.filter.model === 'classic' }" @click="ks.set(['filter', 'model'], 'classic')">CLASSIC</button>
          <button type="button" class="filter-model-btn to-morph" :class="{ active: params.filter.model === 'morph' }" @click="ks.set(['filter', 'model'], 'morph')">MORPH</button>
        </div>
        <div v-if="params.filter.model !== 'morph'" class="filter-type-selector">
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'lp' }" @click="ks.set(['filter', 'type'], 'lp')">LP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'bp' }" @click="ks.set(['filter', 'type'], 'bp')">BP</button>
          <button type="button" class="filter-type-btn" :class="{ active: params.filter.type === 'hp' }" @click="ks.set(['filter', 'type'], 'hp')">HP</button>
        </div>
        <div v-else class="knob-row">
          <Knob :label="knobLabel('filter.morph')" :min="0" :max="2" :step="0.01" :defaultValue="DEFAULTS.filter.morph" :modelValue="params.filter.morph" @update:modelValue="ks.set(['filter', 'morph'], $event)" :syncPath="ks.pathFor(['filter', 'morph'])" @gesture-end="ks.end(['filter', 'morph'])" />
        </div>
        <div class="knob-row">
          <Knob :label="knobLabel('filter.cutoff')" :min="20" :max="20000" :step="1" format="hz" curve="exp" :defaultValue="DEFAULTS.filter.cutoff" :modelValue="params.filter.cutoff" @update:modelValue="ks.set(['filter', 'cutoff'], $event)" :syncPath="ks.pathFor(['filter', 'cutoff'])" @gesture-end="ks.end(['filter', 'cutoff'])" />
          <Knob :label="knobLabel('filter.resonance')" :min="0" :max="1" :step="0.01" format="percent" curve="s" :defaultValue="DEFAULTS.filter.resonance" :modelValue="params.filter.resonance" @update:modelValue="ks.set(['filter', 'resonance'], $event)" :syncPath="ks.pathFor(['filter', 'resonance'])" @gesture-end="ks.end(['filter', 'resonance'])" />
          <Knob :label="knobLabel('filter.keyTrack')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.keyTrack" :modelValue="params.filter.keyTrack" @update:modelValue="ks.set(['filter', 'keyTrack'], $event)" :syncPath="ks.pathFor(['filter', 'keyTrack'])" @gesture-end="ks.end(['filter', 'keyTrack'])" />
          <Knob :label="knobLabel('filter.envAmount')" :min="-4" :max="4" :step="0.1" :defaultValue="DEFAULTS.filter.envAmount" :modelValue="params.filter.envAmount" @update:modelValue="ks.set(['filter', 'envAmount'], $event)" :syncPath="ks.pathFor(['filter', 'envAmount'])" @gesture-end="ks.end(['filter', 'envAmount'])" />
          <Knob :label="knobLabel('filter.drive')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.filter.drive" :modelValue="params.filter.drive" @update:modelValue="ks.set(['filter', 'drive'], $event)" :syncPath="ks.pathFor(['filter', 'drive'])" @gesture-end="ks.end(['filter', 'drive'])" />
        </div>
      </div>
    </div>

    <!-- Column 6: Filter envelope (env2) -->
    <div class="rack-column">
      <div class="module-group">
        <h3>ENV 2 · {{ SYNTH2_ENV_ROLES.env2.toUpperCase() }}</h3>
        <div class="knob-row env-knob-row">
          <Knob v-if="!params.env2.sync" :label="knobLabel('env2.a')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env2.a" :modelValue="params.env2.a" @update:modelValue="ks.set(['env2', 'a'], $event)" :syncPath="ks.pathFor(['env2', 'a'])" @gesture-end="ks.end(['env2', 'a'])" />
          <Knob v-else :label="knobLabel('env2.a')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env2.aDiv)" :modelValue="envDivisionLabelToIndex(params.env2.aDiv)" @update:modelValue="ks.set(['env2', 'aDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env2', 'aDiv'])" @gesture-end="ks.end(['env2', 'aDiv'])" />
          <Knob v-if="!params.env2.sync" :label="knobLabel('env2.d')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env2.d" :modelValue="params.env2.d" @update:modelValue="ks.set(['env2', 'd'], $event)" :syncPath="ks.pathFor(['env2', 'd'])" @gesture-end="ks.end(['env2', 'd'])" />
          <Knob v-else :label="knobLabel('env2.d')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env2.dDiv)" :modelValue="envDivisionLabelToIndex(params.env2.dDiv)" @update:modelValue="ks.set(['env2', 'dDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env2', 'dDiv'])" @gesture-end="ks.end(['env2', 'dDiv'])" />
          <Knob :label="knobLabel('env2.s')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env2.s" :modelValue="params.env2.s" @update:modelValue="ks.set(['env2', 's'], $event)" :syncPath="ks.pathFor(['env2', 's'])" @gesture-end="ks.end(['env2', 's'])" />
          <Knob v-if="!params.env2.sync" :label="knobLabel('env2.r')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env2.r" :modelValue="params.env2.r" @update:modelValue="ks.set(['env2', 'r'], $event)" :syncPath="ks.pathFor(['env2', 'r'])" @gesture-end="ks.end(['env2', 'r'])" />
          <Knob v-else :label="knobLabel('env2.r')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env2.rDiv)" :modelValue="envDivisionLabelToIndex(params.env2.rDiv)" @update:modelValue="ks.set(['env2', 'rDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env2', 'rDiv'])" @gesture-end="ks.end(['env2', 'rDiv'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env2.loop }" @click="ks.set(['env2', 'loop'], !params.env2.loop)">LOOP</button>
        <button type="button" class="env-sync-btn" :class="{ active: params.env2.sync }" @click="ks.set(['env2', 'sync'], !params.env2.sync)">SYNC</button>
      </div>
    </div>

    <!-- Column 7: Mod envelope (env3) -->
    <div class="rack-column">
      <div class="module-group">
        <h3>ENV 3 · {{ SYNTH2_ENV_ROLES.env3.toUpperCase() }}</h3>
        <div class="knob-row env-knob-row">
          <Knob v-if="!params.env3.sync" :label="knobLabel('env3.a')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env3.a" :modelValue="params.env3.a" @update:modelValue="ks.set(['env3', 'a'], $event)" :syncPath="ks.pathFor(['env3', 'a'])" @gesture-end="ks.end(['env3', 'a'])" />
          <Knob v-else :label="knobLabel('env3.a')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env3.aDiv)" :modelValue="envDivisionLabelToIndex(params.env3.aDiv)" @update:modelValue="ks.set(['env3', 'aDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env3', 'aDiv'])" @gesture-end="ks.end(['env3', 'aDiv'])" />
          <Knob v-if="!params.env3.sync" :label="knobLabel('env3.d')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env3.d" :modelValue="params.env3.d" @update:modelValue="ks.set(['env3', 'd'], $event)" :syncPath="ks.pathFor(['env3', 'd'])" @gesture-end="ks.end(['env3', 'd'])" />
          <Knob v-else :label="knobLabel('env3.d')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env3.dDiv)" :modelValue="envDivisionLabelToIndex(params.env3.dDiv)" @update:modelValue="ks.set(['env3', 'dDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env3', 'dDiv'])" @gesture-end="ks.end(['env3', 'dDiv'])" />
          <Knob :label="knobLabel('env3.s')" :min="0" :max="1" :step="0.01" format="percent" :defaultValue="DEFAULTS.env3.s" :modelValue="params.env3.s" @update:modelValue="ks.set(['env3', 's'], $event)" :syncPath="ks.pathFor(['env3', 's'])" @gesture-end="ks.end(['env3', 's'])" />
          <Knob v-if="!params.env3.sync" :label="knobLabel('env3.r')" :min="0.001" :max="10" :step="0.001" format="ms" curve="exp" :defaultValue="DEFAULTS.env3.r" :modelValue="params.env3.r" @update:modelValue="ks.set(['env3', 'r'], $event)" :syncPath="ks.pathFor(['env3', 'r'])" @gesture-end="ks.end(['env3', 'r'])" />
          <Knob v-else :label="knobLabel('env3.r')" :min="0" :max="ENV_SYNC_LABELS.length - 1" :step="1" :labels="ENV_SYNC_KNOB_LABELS" :defaultValue="envDivisionLabelToIndex(DEFAULTS.env3.rDiv)" :modelValue="envDivisionLabelToIndex(params.env3.rDiv)" @update:modelValue="ks.set(['env3', 'rDiv'], ENV_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['env3', 'rDiv'])" @gesture-end="ks.end(['env3', 'rDiv'])" />
        </div>
        <button type="button" class="loop-btn" :class="{ active: params.env3.loop }" @click="ks.set(['env3', 'loop'], !params.env3.loop)">LOOP</button>
        <button type="button" class="env-sync-btn" :class="{ active: params.env3.sync }" @click="ks.set(['env3', 'sync'], !params.env3.sync)">SYNC</button>
      </div>
    </div>

    <!-- Column 8: LFOs -->
    <div class="rack-column">
      <div class="module-group">
        <h3>LFO 1</h3>
        <WavePreview kind="lfo" :shape="params.lfo1.shape" :mode="params.lfo1.mode" :color="color" />
        <div class="knob-row">
          <Knob v-if="!params.lfo1.sync" :label="knobLabel('lfo1.rate')" :min="0.01" :max="2000" :step="0.01" format="hz" curve="exp" :defaultValue="DEFAULTS.lfo1.rate" :modelValue="params.lfo1.rate" @update:modelValue="ks.set(['lfo1', 'rate'], $event)" :syncPath="ks.pathFor(['lfo1', 'rate'])" @gesture-end="ks.end(['lfo1', 'rate'])" />
          <Knob v-else :label="knobLabel('lfo1.rate')" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.lfo1.div)" :modelValue="divisionLabelToIndex(params.lfo1.div)" @update:modelValue="ks.set(['lfo1', 'div'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['lfo1', 'div'])" @gesture-end="ks.end(['lfo1', 'div'])" />
          <Knob v-if="params.lfo1.mode === 'off'" :label="knobLabel('lfo1.shape')" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo1.shape" :modelValue="params.lfo1.shape" @update:modelValue="ks.set(['lfo1', 'shape'], $event)" :syncPath="ks.pathFor(['lfo1', 'shape'])" @gesture-end="ks.end(['lfo1', 'shape'])" />
        </div>
        <div class="lfo-mode-selector">
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo1.mode === 'off' }" @click="ks.set(['lfo1', 'mode'], 'off')">OFF</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo1.mode === 's&h' }" @click="ks.set(['lfo1', 'mode'], 's&h')">S&amp;H</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo1.mode === 'smooth' }" @click="ks.set(['lfo1', 'mode'], 'smooth')">SMOOTH</button>
        </div>
        <button type="button" class="lfo-sync-btn" :class="{ active: params.lfo1.sync }" @click="ks.set(['lfo1', 'sync'], !params.lfo1.sync)">SYNC</button>
      </div>
      <div class="module-group">
        <h3>LFO 2</h3>
        <WavePreview kind="lfo" :shape="params.lfo2.shape" :mode="params.lfo2.mode" :color="color" />
        <div class="knob-row">
          <Knob v-if="!params.lfo2.sync" :label="knobLabel('lfo2.rate')" :min="0.01" :max="2000" :step="0.01" format="hz" curve="exp" :defaultValue="DEFAULTS.lfo2.rate" :modelValue="params.lfo2.rate" @update:modelValue="ks.set(['lfo2', 'rate'], $event)" :syncPath="ks.pathFor(['lfo2', 'rate'])" @gesture-end="ks.end(['lfo2', 'rate'])" />
          <Knob v-else :label="knobLabel('lfo2.rate')" :min="0" :max="LFO_SYNC_LABELS.length - 1" :step="1" :labels="LFO_SYNC_LABELS" :defaultValue="divisionLabelToIndex(DEFAULTS.lfo2.div)" :modelValue="divisionLabelToIndex(params.lfo2.div)" @update:modelValue="ks.set(['lfo2', 'div'], LFO_SYNC_LABELS[$event])" :syncPath="ks.pathFor(['lfo2', 'div'])" @gesture-end="ks.end(['lfo2', 'div'])" />
          <Knob v-if="params.lfo2.mode === 'off'" :label="knobLabel('lfo2.shape')" :min="0" :max="4" :step="0.01" :defaultValue="DEFAULTS.lfo2.shape" :modelValue="params.lfo2.shape" @update:modelValue="ks.set(['lfo2', 'shape'], $event)" :syncPath="ks.pathFor(['lfo2', 'shape'])" @gesture-end="ks.end(['lfo2', 'shape'])" />
        </div>
        <div class="lfo-mode-selector">
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo2.mode === 'off' }" @click="ks.set(['lfo2', 'mode'], 'off')">OFF</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo2.mode === 's&h' }" @click="ks.set(['lfo2', 'mode'], 's&h')">S&amp;H</button>
          <button type="button" class="lfo-mode-btn" :class="{ active: params.lfo2.mode === 'smooth' }" @click="ks.set(['lfo2', 'mode'], 'smooth')">SMOOTH</button>
        </div>
        <button type="button" class="lfo-sync-btn" :class="{ active: params.lfo2.sync }" @click="ks.set(['lfo2', 'sync'], !params.lfo2.sync)">SYNC</button>
      </div>
    </div>

    <!-- Column 9: Mod matrix -->
    <div class="rack-column">
      <div class="module-group">
        <h3>MATRIX</h3>
        <div class="matrix-grid">
          <div v-for="(slot, s) in params.matrix" :key="s" class="matrix-row">
            <select class="matrix-source" :value="slot.source" @change="ks.set(['matrix', s, 'source'], ($event.target as HTMLSelectElement).value)">
              <option v-for="src in MOD_SOURCES" :key="src" :value="src">{{ MOD_SOURCE_LABELS[src] }}</option>
            </select>
            <select class="matrix-dest" :value="slot.dest" @change="ks.set(['matrix', s, 'dest'], ($event.target as HTMLSelectElement).value)">
              <option v-for="dst in MOD_DESTS" :key="dst" :value="dst">{{ modDestLabel(dst) }}</option>
            </select>
            <Knob label="Amt" :min="-1" :max="1" :step="0.01" :defaultValue="0" :modelValue="slot.amount" @update:modelValue="ks.set(['matrix', s, 'amount'], $event)" :syncPath="ks.pathFor(['matrix', s, 'amount'])" @gesture-end="ks.end(['matrix', s, 'amount'])" />
          </div>
        </div>
      </div>
    </div>

    <!-- Column 10: Visualizer -->
    <div class="rack-column">
      <Visualizer :analyser="analyser" :color="color" />
    </div>
  </div>
</template>

<script setup lang="ts">
import Knob from './Knob.vue';
import Visualizer from './Visualizer.vue';
import WavePreview from './WavePreview.vue';
import { Synth2Engine } from '../engine/Synth2Engine';
import { MOD_SOURCES, MOD_DESTS, MOD_SOURCE_LABELS, modDestLabel, knobLabel, SYNTH2_ENV_ROLES, LFO_SYNC_LABELS, divisionLabelToIndex, ENV_SYNC_LABELS, ENV_SYNC_KNOB_LABELS, envDivisionLabelToIndex } from '@fiddle/shared';
import { useKnobSync } from '../sync/knobSync';
import type { EngineParamsMap } from '../project';

const DEFAULTS = Synth2Engine.DEFAULT_PARAMS;
const ks = useKnobSync('synth2');

defineProps<{
  params: EngineParamsMap['synth2'];
  analyser: AnalyserNode | null;
  color: string;
}>();
</script>

<style scoped>
/* .synth-mode-selector styling is global (App.vue), shared with SynthPanel. */

/* Env A/D/R readouts show step labels up to 7 chars ("1/16 st"), one more
   than the Knob default box fits. These rows have only 4 knobs, so the wider
   readout still fits the card (4 × 56 + 3 × 10 gap = 254px); the Knob default
   stays 48px because the 5-knob osc/filter rows are sized to it. The custom
   property inherits into Knob.vue through Vue style scoping. */
.env-knob-row {
  --knob-value-width: 56px;
}

/* Glide (portamento) rides the shared mode-selector row. The selector's flex
   styling is global (App.vue, shared with synth1); these scoped rules only
   affect synth2's instance. Knob centers against the taller row; step labels
   ("1/16 st") need the wider readout, same as the env rows. */
.synth-mode-selector { align-items: center; }
.glide-control {
  display: flex;
  align-items: center;
  gap: 8px;
  --knob-value-width: 56px;
}
.glide-sync-btn {
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 10px;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.glide-sync-btn:hover { color: #aaa; border-color: #444; }
.glide-sync-btn.active { background: #222; color: #fff; border-color: #555; }

.sync-btn,
.loop-btn,
.lfo-sync-btn,
.env-sync-btn {
  width: 100%;
  margin-top: 6px;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 10px;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.sync-btn:hover,
.loop-btn:hover,
.lfo-sync-btn:hover,
.env-sync-btn:hover { color: #aaa; border-color: #444; }
.sync-btn.active,
.loop-btn.active,
.lfo-sync-btn.active,
.env-sync-btn.active { background: #222; color: #fff; border-color: #555; }
.filter-type-selector {
  display: flex;
  gap: 6px;
  width: 100%;
  margin-bottom: 8px;
}
.filter-type-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.filter-type-btn:hover { color: #aaa; border-color: #444; }
.filter-type-btn.active { background: #222; color: #fff; border-color: #555; }
.filter-model-selector { display: flex; gap: 4px; margin-bottom: 6px; }
.filter-model-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.7rem;
  font-weight: bold;
  letter-spacing: 0.05em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.filter-model-btn:hover { color: #aaa; border-color: #444; }
.filter-model-btn.active { background: #222; color: #fff; border-color: #555; }
.lfo-mode-selector { display: flex; gap: 4px; width: 100%; margin-top: 6px; }
.lfo-mode-btn {
  flex: 1;
  background: #181818;
  color: #666;
  border: 1px solid #2a2a2a;
  border-radius: 4px;
  padding: 5px 0;
  font-family: monospace;
  font-size: 0.65rem;
  font-weight: bold;
  letter-spacing: 0.03em;
  cursor: pointer;
  transition: all 0.2s ease;
}
.lfo-mode-btn:hover { color: #aaa; border-color: #444; }
.lfo-mode-btn.active { background: #222; color: #fff; border-color: #555; }
.matrix-grid { display: flex; flex-direction: column; gap: 4px; }
.matrix-row { display: flex; align-items: center; gap: 4px; }
.matrix-row select {
  flex: 1; min-width: 0; background: #181818; color: #aaa;
  border: 1px solid #2a2a2a; border-radius: 4px; padding: 3px 4px;
  font-family: monospace; font-size: 0.65rem;
}
</style>
