# Task 2: Core Engine & Module Interfaces Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Define core types and the `PatchBay` class for managing Web Audio connections.

**Architecture:** A decoupled patch bay that handles connections between `AudioNode`s and `AudioParam`s, abstracted via a `ModulePort` type.

**Tech Stack:** TypeScript, Web Audio API, Vitest for testing.

---

### Task 2.1: Core Types

**Files:**
- Create: `src/engine/types.ts`

- [ ] **Step 1: Create `src/engine/types.ts`**
```typescript
export type ModulePort = AudioNode | AudioParam;

export interface Module {
  readonly name: string;
  readonly inputs: Record<string, ModulePort>;
  readonly outputs: Record<string, ModulePort>;
}
```

- [ ] **Step 2: Commit**
```bash
git add src/engine/types.ts
git commit -m "feat: define core engine types"
```

---

### Task 2.2: PatchBay Implementation (TDD)

**Files:**
- Create: `src/engine/PatchBay.ts`
- Create: `src/engine/PatchBay.test.ts`

- [ ] **Step 1: Write the failing test for `PatchBay`**
```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PatchBay } from './PatchBay';

describe('PatchBay', () => {
  let patchBay: PatchBay;
  let ctx: AudioContext;

  beforeEach(() => {
    patchBay = new PatchBay();
    ctx = new AudioContext();
  });

  it('should connect an AudioNode to another AudioNode', () => {
    const source = ctx.createGain();
    const target = ctx.createGain();
    const connectSpy = vi.spyOn(source, 'connect');
    
    patchBay.connect(source, target);
    
    expect(connectSpy).toHaveBeenCalledWith(target);
  });

  it('should connect an AudioNode to an AudioParam', () => {
    const source = ctx.createGain();
    const target = ctx.createGain().gain;
    const connectSpy = vi.spyOn(source, 'connect');
    
    patchBay.connect(source, target);
    
    expect(connectSpy).toHaveBeenCalledWith(target);
  });

  it('should throw an error if source is not an AudioNode', () => {
    const source = ctx.createGain().gain as any;
    const target = ctx.createGain();
    
    expect(() => patchBay.connect(source, target)).toThrow("Source must be an AudioNode to connect to a target.");
  });

  it('should disconnect an AudioNode from another AudioNode', () => {
    const source = ctx.createGain();
    const target = ctx.createGain();
    const disconnectSpy = vi.spyOn(source, 'disconnect');
    
    patchBay.disconnect(source, target);
    
    expect(disconnectSpy).toHaveBeenCalledWith(target);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**
Run: `npx vitest run src/engine/PatchBay.test.ts`
Expected: FAIL (Module not found or compilation error)

- [ ] **Step 3: Implement `PatchBay`**
```typescript
import { ModulePort } from './types';

export class PatchBay {
  connect(source: ModulePort, target: ModulePort) {
    if (source instanceof AudioNode) {
      if (target instanceof AudioNode) {
        source.connect(target);
      } else if (target instanceof AudioParam) {
        source.connect(target);
      }
    } else {
        throw new Error("Source must be an AudioNode to connect to a target.");
    }
  }

  disconnect(source: ModulePort, target: ModulePort) {
    if (source instanceof AudioNode) {
        if (target instanceof AudioNode) {
            source.disconnect(target);
        } else if (target instanceof AudioParam) {
            source.disconnect(target);
        }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**
Run: `npx vitest run src/engine/PatchBay.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/engine/PatchBay.ts src/engine/PatchBay.test.ts
git commit -m "feat: implement PatchBay with TDD"
```
