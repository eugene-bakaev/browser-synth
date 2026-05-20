# Synth Engine Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `SynthEngine` to wire modules together.

**Architecture:** `SynthEngine` will act as the central orchestrator, initializing an `AudioContext`, all necessary synthesis modules (`Oscillator`, `Mixer`, `Filter`, `Envelope`), and a `PatchBay` for internal routing. It will provide a `trigger` method to play notes by coordinating module parameters and envelope triggers.

**Tech Stack:** TypeScript, Web Audio API

---

### Task 1: Research and Setup

**Files:**
- Modify: `MEMORY.md` (if needed to track progress)

- [ ] **Step 1: Verify existing modules**
I have already read the module files. They match the expected interfaces.

### Task 2: Implement SynthEngine with TDD

**Files:**
- Create: `src/engine/SynthEngine.test.ts`
- Create: `src/engine/SynthEngine.ts`

- [ ] **Step 1: Write the failing test for SynthEngine**

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SynthEngine } from './SynthEngine';

describe('SynthEngine', () => {
  it('should initialize all modules', () => {
    const engine = new SynthEngine();
    expect(engine.osc1).toBeDefined();
    expect(engine.osc2).toBeDefined();
    expect(engine.mixer).toBeDefined();
    expect(engine.filter).toBeDefined();
    expect(engine.ampEnv).toBeDefined();
    expect(engine.filterEnv).toBeDefined();
  });

  it('should trigger a note', () => {
    const engine = new SynthEngine();
    const freq = 440;
    const duration = 0.5;
    
    // We can't easily test the audio output without complex mocks,
    // but we can check if it doesn't throw and if resume was called if suspended.
    expect(() => engine.trigger(freq, duration)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/engine/SynthEngine.test.ts`
Expected: FAIL (SynthEngine not defined)

- [ ] **Step 3: Implement SynthEngine**

```typescript
import { PatchBay } from './PatchBay';
import { OscillatorModule } from './modules/Oscillator';
import { MixerModule } from './modules/Mixer';
import { FilterModule } from './modules/Filter';
import { EnvelopeModule } from './modules/Envelope';

export class SynthEngine {
  ctx: AudioContext;
  private patchBay: PatchBay;
  
  osc1: OscillatorModule;
  osc2: OscillatorModule;
  mixer: MixerModule;
  filter: FilterModule;
  ampEnv: EnvelopeModule;
  filterEnv: EnvelopeModule;
  masterVCA: GainNode;

  constructor() {
    this.ctx = new AudioContext();
    this.patchBay = new PatchBay();
    
    this.osc1 = new OscillatorModule(this.ctx);
    this.osc2 = new OscillatorModule(this.ctx);
    this.mixer = new MixerModule(this.ctx);
    this.filter = new FilterModule(this.ctx);
    this.ampEnv = new EnvelopeModule();
    this.filterEnv = new EnvelopeModule();
    this.masterVCA = this.ctx.createGain();
    this.masterVCA.gain.value = 0;

    // Hardwired routing
    this.patchBay.connect(this.osc1.outputs.main, this.mixer.inputs.main);
    this.patchBay.connect(this.osc2.outputs.main, this.mixer.inputs.main);
    this.patchBay.connect(this.mixer.outputs.main, this.filter.inputs.main);
    this.patchBay.connect(this.filter.outputs.main, this.masterVCA);
    this.masterVCA.connect(this.ctx.destination);
  }

  trigger(freq: number, duration: number) {
    if (this.ctx.state === 'suspended') {
        this.ctx.resume();
    }
    const now = this.ctx.currentTime;
    this.osc1.setFrequency(freq);
    this.osc2.setFrequency(freq * 1.01); // slight detune
    
    // Trigger Amplitude Envelope
    this.ampEnv.trigger(this.masterVCA.gain, now, duration);
    
    // Trigger Filter Envelope (Modulating Cutoff)
    if (this.filter.inputs.cutoff instanceof AudioParam) {
        this.filterEnv.trigger(this.filter.inputs.cutoff, now, duration);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/engine/SynthEngine.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/engine/SynthEngine.ts src/engine/SynthEngine.test.ts
git commit -m "feat: implement SynthEngine orchestration"
```
