//
// Rate-integrating ADSR state machine (spec §5.4): each sample advances the
// level by a slope computed from the CURRENT a/d/s/r slot values, so stage
// times are modulatable mid-flight (matrix arrives in I3; the design is laid
// in now). The class is named for its I3 destiny — `loop` mode (attack⇄decay
// cycling while gated) is appended then; I1 is a plain ADSR.
//
// D3 preserved in-kernel: a retrigger while the level is non-zero enters a
// 1ms 'steal' ramp to 0 before the attack, eliminating retrigger clicks.
//
// Gate timing is sample-counted: noteOn(gateFrames) starts release exactly
// gateFrames samples later, mirroring the trigger(freq, duration, …) contract.
//
// CADENCE NOTE (I3): each ParamSlot advances only while its stage is active
// (a during attack, d+s during decay, s during sustain, r during release) —
// a deliberate deviation from ParamSlot's "exactly once per sample" doc. An
// idle slot's 5ms smoother is paused until its stage runs. Revisit when the
// I3 mod matrix takes over per-sample slot cadence.

import type { ParamSlot } from './ParamSlot';

type Stage = 'idle' | 'steal' | 'attack' | 'decay' | 'sustain' | 'release';

const STEAL_SECONDS = 0.001;

export class LoopEnvelope {
  level = 0;

  private stage: Stage = 'idle';
  private gateRemaining = 0;
  private releaseFrom = 1;
  private readonly dt: number;
  private readonly stealStep: number;

  constructor(
    private readonly a: ParamSlot,
    private readonly d: ParamSlot,
    private readonly s: ParamSlot,
    private readonly r: ParamSlot,
    sampleRate: number,
  ) {
    this.dt = 1 / sampleRate;
    this.stealStep = 1 / (STEAL_SECONDS * sampleRate);
  }

  get active(): boolean {
    return this.stage !== 'idle';
  }

  noteOn(gateFrames: number): void {
    this.gateRemaining = Math.max(1, gateFrames);
    this.stage = this.level > 0 ? 'steal' : 'attack';
  }

  next(): number {
    switch (this.stage) {
      case 'idle':
        return 0;
      case 'steal':
        this.level -= this.stealStep;
        if (this.level <= 0) {
          this.level = 0;
          this.stage = 'attack';
        }
        break;
      case 'attack':
        this.level += this.dt / this.a.next();
        if (this.level >= 1) {
          this.level = 1;
          this.stage = 'decay';
        }
        break;
      case 'decay': {
        const sus = this.s.next();
        this.level -= (this.dt * (1 - sus)) / this.d.next();
        if (this.level <= sus) {
          this.level = sus;
          this.stage = 'sustain';
        }
        break;
      }
      case 'sustain':
        this.level = this.s.next();
        break;
      case 'release':
        this.level -= (this.dt * this.releaseFrom) / this.r.next();
        if (this.level <= 0) {
          this.level = 0;
          this.stage = 'idle';
        }
        break;
    }

    // Gate countdown runs through steal/attack/decay/sustain; when it
    // expires, enter release from wherever the level currently is.
    // Steal frames count against the gate: a sub-1ms gate on retrigger can go
    // steal → release without ever attacking (harmless; sequencer gates are ≫1ms).
    if (this.stage !== 'idle' && this.stage !== 'release') {
      this.gateRemaining--;
      if (this.gateRemaining <= 0) {
        this.stage = 'release';
        this.releaseFrom = Math.max(this.level, 0.001);
      }
    }

    return this.level;
  }
}
