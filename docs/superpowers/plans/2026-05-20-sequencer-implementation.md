# Sequencer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a 16-step tracker logic with BPM control and step trigger callbacks.

**Architecture:** A `Sequencer` class that manages an array of 16 steps and uses `setInterval` for timing.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Setup Directory

**Files:**
- Create: `src/sequencer/`

- [ ] **Step 1: Create the sequencer directory**

Run: `mkdir -p src/sequencer`
Expected: Directory created.

- [ ] **Step 2: Commit**

```bash
git add src/sequencer
git commit -m "chore: create sequencer directory"
```

### Task 2: Implement Sequencer Logic with TDD

**Files:**
- Create: `src/sequencer/Sequencer.ts`
- Create: `src/sequencer/Sequencer.test.ts`

- [ ] **Step 1: Write failing test for Sequencer initialization**

```typescript
import { describe, it, expect } from 'vitest';
import { Sequencer } from './Sequencer';

describe('Sequencer', () => {
  it('should initialize with 16 empty steps and default BPM', () => {
    const seq = new Sequencer();
    expect(seq.steps.length).toBe(16);
    expect(seq.bpm).toBe(120);
    expect(seq.isPlaying).toBe(false);
    seq.steps.forEach(step => {
      expect(step.note).toBeNull();
      expect(step.octave).toBe(4);
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test src/sequencer/Sequencer.test.ts`
Expected: FAIL (Sequencer not found)

- [ ] **Step 3: Implement minimal Sequencer class**

```typescript
export interface Step {
  note: string | null;
  octave: number;
}

export class Sequencer {
  steps: Step[] = Array(16).fill(null).map(() => ({ note: null, octave: 4 }));
  bpm = 120;
  isPlaying = false;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test src/sequencer/Sequencer.test.ts`
Expected: PASS

- [ ] **Step 5: Write failing test for start/stop logic**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Sequencer } from './Sequencer';

describe('Sequencer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should start and stop playback, triggering callbacks', () => {
    const seq = new Sequencer();
    const callback = vi.fn();
    
    seq.start(callback);
    expect(seq.isPlaying).toBe(true);
    
    // BPM 120 -> 500ms per beat -> 125ms per 16th note
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(1);
    
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2);
    
    seq.stop();
    expect(seq.isPlaying).toBe(false);
    
    vi.advanceTimersByTime(125);
    expect(callback).toHaveBeenCalledTimes(2); // Should not increase
  });
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `npm test src/sequencer/Sequencer.test.ts`
Expected: FAIL (start/stop not implemented)

- [ ] **Step 7: Implement full Sequencer logic**

```typescript
export interface Step {
  note: string | null;
  octave: number;
}

export class Sequencer {
  steps: Step[] = Array(16).fill(null).map(() => ({ note: null, octave: 4 }));
  bpm = 120;
  private currentStep = 0;
  private timer: any = null; // Use any for cross-env compatibility if needed, or number | null
  isPlaying = false;

  start(callback: (step: Step) => void) {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    const stepTime = (60 / this.bpm) / 4;
    
    this.timer = setInterval(() => {
      callback(this.steps[this.currentStep]);
      this.currentStep = (this.currentStep + 1) % 16;
    }, stepTime * 1000);
  }

  stop() {
    this.isPlaying = false;
    if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
    }
    this.currentStep = 0;
  }
}
```

- [ ] **Step 8: Run test to verify it passes**

Run: `npm test src/sequencer/Sequencer.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/sequencer/Sequencer.ts src/sequencer/Sequencer.test.ts
git commit -m "feat: implement Sequencer with TDD"
```
