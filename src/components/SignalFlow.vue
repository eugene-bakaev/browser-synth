<template>
  <div class="signal-flow-container">
    <div class="flow-header">
      <span class="flow-title">Signal Flow Diagram</span>
      <span class="flow-engine" :style="{ color: color, borderColor: color }">
        {{ engineType.toUpperCase() }} ENGINE
      </span>
    </div>
    
    <div class="flow-diagram">
      <!-- Connector Line Canvas/SVG behind nodes -->
      <svg class="flow-connections" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="flow-grad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" :stop-color="color" stop-opacity="0.1" />
            <stop offset="50%" :stop-color="color" stop-opacity="1" />
            <stop offset="100%" :stop-color="color" stop-opacity="0.1" />
          </linearGradient>
        </defs>
        
        <!-- We will draw path lines between coordinates. Since it is a linear flow, we can use simple horizontal lines with animation -->
        <line 
          x1="10%" y1="50%" x2="90%" y2="50%" 
          stroke="#1e293b" 
          stroke-width="2" 
        />
        <line 
          x1="10%" y1="50%" x2="90%" y2="50%" 
          :stroke="color" 
          stroke-width="2" 
          stroke-dasharray="10, 15"
          class="pulse-line"
        />
      </svg>

      <div class="flow-nodes-wrapper">
        <div 
          v-for="(node, index) in activeNodes" 
          :key="node.id" 
          class="flow-node"
          :class="{ active: node.isActive }"
          :style="node.isActive ? { '--node-glow': color, borderColor: color } : {}"
        >
          <div class="node-icon" v-html="node.icon"></div>
          <div class="node-label">{{ node.label }}</div>
          <div class="node-sub">{{ node.description }}</div>
          
          <!-- Connector arrow (except for last node) -->
          <div v-if="index < activeNodes.length - 1" class="node-arrow" :style="{ color: color }">
            ➔
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';

type EngineType = 'synth' | 'kick' | 'hat' | 'snare' | 'clap';

const props = withDefaults(
  defineProps<{
    engineType?: EngineType;
    color?: string;
  }>(),
  {
    engineType: 'synth',
    color: '#00f0ff'
  }
);

interface FlowNode {
  id: string;
  label: string;
  description: string;
  icon: string; // SVG path or icon markup
  isActive: boolean;
}

const activeNodes = computed<FlowNode[]>(() => {
  const t = props.engineType;
  
  const synthNodes: FlowNode[] = [
    {
      id: 'osc',
      label: 'OSC 1 & 2',
      description: 'Dual Waveform Generators',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h3l3-9 4 18 3-12 2 3h5"/></svg>',
      isActive: t === 'synth'
    },
    {
      id: 'mixer',
      label: 'Mixer',
      description: 'Levels & Balance Control',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 10h16M4 14h16M8 8v4M16 12v4"/></svg>',
      isActive: t === 'synth'
    },
    {
      id: 'filter',
      label: 'L.P. Filter',
      description: 'Low-pass + Filter Env Cutoff',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M6 12h12M10 18h4"/></svg>',
      isActive: t === 'synth'
    },
    {
      id: 'vca',
      label: 'VCA / Envelope',
      description: 'Amp ADSR Modulation',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 18l6-10 6 7 6-12"/></svg>',
      isActive: t === 'synth'
    },
    {
      id: 'out',
      label: 'Audio Out',
      description: 'Master Audio Dest',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      isActive: t === 'synth'
    }
  ];

  const kickNodes: FlowNode[] = [
    {
      id: 'sine',
      label: 'Pitch Sweep',
      description: 'Sine wave oscillator frequency sweep',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12q3-7 6 0t6 0t6 0"/></svg>',
      isActive: t === 'kick'
    },
    {
      id: 'click',
      label: 'Click Gen',
      description: 'High-frequency pop overlay',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
      isActive: t === 'kick'
    },
    {
      id: 'vca',
      label: 'Amp Envelope',
      description: 'Exponential volume decay',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18L12 8l9 10"/></svg>',
      isActive: t === 'kick'
    },
    {
      id: 'out',
      label: 'Audio Out',
      description: 'Master Output',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      isActive: t === 'kick'
    }
  ];

  const hatNodes: FlowNode[] = [
    {
      id: 'square_array',
      label: '6x Osc Array',
      description: 'Metallic detuned square waves',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h2v4h4v-8h4v8h4v-8h4v4h2"/></svg>',
      isActive: t === 'hat'
    },
    {
      id: 'bpf',
      label: 'B.P. Filter',
      description: 'High metallic bandpass cut',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6l9 6-9 6M21 6l-9 6 9 6"/></svg>',
      isActive: t === 'hat'
    },
    {
      id: 'vca',
      label: 'Amp Envelope',
      description: 'Ultra fast decay envelope',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18L9 14l12 4"/></svg>',
      isActive: t === 'hat'
    },
    {
      id: 'out',
      label: 'Audio Out',
      description: 'Master Output',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      isActive: t === 'hat'
    }
  ];

  const snareNodes: FlowNode[] = [
    {
      id: 'snare_osc',
      label: 'Triangle Osc',
      description: 'Low-frequency drum body tone',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 17L12 5l9 12"/></svg>',
      isActive: t === 'snare'
    },
    {
      id: 'noise',
      label: 'White Noise',
      description: 'High snappy snare rattle',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 10h1v4h2v-6h2v6h2v-4h2v4h2v-8h2v8h2v-4h2v4h2v-10h1"/></svg>',
      isActive: t === 'snare'
    },
    {
      id: 'bpf',
      label: 'Bandpass Filter',
      description: 'Filtered rattle body',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M6 12h12M10 18h4"/></svg>',
      isActive: t === 'snare'
    },
    {
      id: 'vca',
      label: 'Snappy VCA',
      description: 'Mixed body/snare amp decay',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18L12 10l9 8"/></svg>',
      isActive: t === 'snare'
    },
    {
      id: 'out',
      label: 'Audio Out',
      description: 'Master Output',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      isActive: t === 'snare'
    }
  ];

  const clapNodes: FlowNode[] = [
    {
      id: 'clap_noise',
      label: 'Noise Source',
      description: 'Sustained white noise generator',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 12h2v4h4v-8h4v8h4v-8h4v4h2"/></svg>',
      isActive: t === 'clap'
    },
    {
      id: 'bpf',
      label: 'Bandpass Filter',
      description: 'Mid frequency clap color filter',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M6 12h12M10 18h4"/></svg>',
      isActive: t === 'clap'
    },
    {
      id: 'burst_vca',
      label: 'Multi-Burst VCA',
      description: 'Triple-envelope clap rattle pop',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 18l3-10 3 8 3-10 3 8 6-12"/></svg>',
      isActive: t === 'clap'
    },
    {
      id: 'out',
      label: 'Audio Out',
      description: 'Master Output',
      icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
      isActive: t === 'clap'
    }
  ];

  switch(t) {
    case 'kick': return kickNodes;
    case 'hat': return hatNodes;
    case 'snare': return snareNodes;
    case 'clap': return clapNodes;
    default: return synthNodes;
  }
});
</script>

<style scoped>
.signal-flow-container {
  background: #090d16;
  border: 1px solid #1a2436;
  border-radius: 8px;
  padding: 15px;
  margin-bottom: 20px;
  box-sizing: border-box;
}

.flow-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 15px;
}

.flow-title {
  font-size: 0.8rem;
  font-weight: bold;
  text-transform: uppercase;
  letter-spacing: 1px;
  color: #64748b;
}

.flow-engine {
  font-size: 0.7rem;
  font-weight: bold;
  padding: 2px 8px;
  border-radius: 4px;
  border: 1px solid currentColor;
  background: rgba(0, 0, 0, 0.2);
}

.flow-diagram {
  position: relative;
  min-height: 80px;
  display: flex;
  align-items: center;
}

.flow-connections {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}

.pulse-line {
  animation: flow-dash 1s linear infinite;
}

@keyframes flow-dash {
  to {
    stroke-dashoffset: -25;
  }
}

.flow-nodes-wrapper {
  display: flex;
  justify-content: space-between;
  width: 100%;
  position: relative;
  z-index: 1;
  gap: 15px;
  flex-wrap: wrap;
}

.flow-node {
  flex: 1;
  min-width: 100px;
  max-width: 160px;
  background: #0d131f;
  border: 1px solid #1e293b;
  border-radius: 6px;
  padding: 10px;
  text-align: center;
  position: relative;
  transition: all 0.3s ease;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
}

.flow-node:hover {
  transform: translateY(-2px);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
}

.flow-node.active {
  background: #0f1a2e;
  box-shadow: 0 0 15px rgba(var(--node-glow), 0.1);
}

.node-icon {
  width: 24px;
  height: 24px;
  margin: 0 auto 6px;
  color: #475569;
  transition: color 0.3s;
}

.flow-node.active .node-icon {
  color: var(--node-glow);
  filter: drop-shadow(0 0 4px var(--node-glow));
}

.node-label {
  font-size: 0.75rem;
  font-weight: bold;
  color: #94a3b8;
  margin-bottom: 2px;
}

.flow-node.active .node-label {
  color: #f1f5f9;
}

.node-sub {
  font-size: 0.65rem;
  color: #475569;
  line-height: 1.2;
}

.flow-node.active .node-sub {
  color: #64748b;
}

.node-arrow {
  position: absolute;
  top: 50%;
  right: -14px;
  transform: translateY(-50%);
  font-size: 0.8rem;
  pointer-events: none;
  z-index: 2;
  opacity: 0.7;
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .flow-nodes-wrapper {
    flex-direction: column;
    align-items: center;
  }
  .flow-node {
    width: 100%;
    max-width: 280px;
  }
  .node-arrow {
    top: auto;
    bottom: -15px;
    right: 50%;
    transform: translateX(50%) rotate(90deg);
  }
  .flow-connections {
    display: none;
  }
}
</style>
