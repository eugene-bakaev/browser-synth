//
// Top level (spec §6.2/§6.7): voice pool + sample-accurate event queue +
// block renderer. Pure TS, zero allocation after construction. process(out,
// frames, blockStartFrame) renders audio into out; frames must equal
// out.length (the code trusts frames, not out.length). blockStartFrame is the
// absolute frame the block starts at (the worklet passes currentFrame; tests
// pass whatever they like).
//
// I2a: 8-voice pool. mono=true (default, backward-compatible) retriggers
// voice 0 exclusively using the existing steal ramp — one voice, clickless.
// mono=false routes through pickVoice: free-first round-robin, oldest-steal
// fallback. applyParams and renderActive loop all voices unchanged. The queue
// is a fixed ring of 64 preallocated events — events are assumed time-ordered
// (the sequencer schedules in order); a full ring drops the oldest event.

import { Voice } from './Voice';
import { PARAM_COUNT, PARAM_INDEX, defaultParamBlock } from './params';
import { pickVoice, VOICE_COUNT } from './allocator';

const MAX_EVENTS = 64;

interface NoteEvent {
  frame: number;
  freq: number;
  gateFrames: number;
  velocity: number;
  mono: boolean;
}

export class Synth2Kernel {
  private readonly voices: Voice[];
  private readonly block: Float32Array = defaultParamBlock();
  private readonly events: NoteEvent[];
  private head = 0; // next event to consume
  private count = 0;

  // Allocation-free poly bookkeeping (reused each allocate() call).
  private readonly activeScratch: boolean[] = new Array(VOICE_COUNT).fill(false);
  private readonly ages: number[] = new Array(VOICE_COUNT).fill(0);
  private rr = 0;
  private ageCounter = 1;

  constructor(private readonly sampleRate: number) {
    this.voices = Array.from({ length: VOICE_COUNT }, (_, i) => new Voice(sampleRate, (i + 1) * 0x9e3779b9));
    this.events = Array.from({ length: MAX_EVENTS }, () => ({
      frame: 0, freq: 440, gateFrames: 0, velocity: 1, mono: true,
    }));
  }

  /** Full param block (base values, descriptor order). Broadcast to voices. */
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) this.block[i] = block[i];
    for (const voice of this.voices) {
      for (let i = 0; i < n; i++) voice.slots[i].setBase(this.block[i]);
    }
    // Discrete (bool/enum) params: applied at the block boundary, no smoother.
    // osc1.sync exists in the descriptor table for a uniform osc shape but is
    // intentionally not read here — osc1 is the master and is never reset.
    const osc2Sync = this.block[PARAM_INDEX['osc2.sync']] >= 0.5;
    const osc3Sync = this.block[PARAM_INDEX['osc3.sync']] >= 0.5;
    const filterType = Math.round(this.block[PARAM_INDEX['filter.type']]);
    for (const voice of this.voices) {
      voice.setSync(osc2Sync, osc3Sync);
      voice.setFilterType(filterType);
    }
  }

  /** time/duration in seconds on the AudioContext clock (SoundEngine contract). */
  noteOn(time: number, freq: number, duration: number, velocity: number, mono = true): void {
    if (this.count === MAX_EVENTS) { // drop oldest
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(time * this.sampleRate);
    ev.freq = freq;
    ev.gateFrames = Math.max(1, Math.round(duration * this.sampleRate));
    ev.velocity = velocity;
    ev.mono = mono;
    this.count++;
  }

  process(out: Float32Array, frames: number, blockStartFrame: number): void {
    out.fill(0);
    let cursor = 0;
    while (this.count > 0) {
      const ev = this.events[this.head];
      if (ev.frame >= blockStartFrame + frames) break; // due in a future block
      const offset = Math.max(0, ev.frame - blockStartFrame); // past-due → now
      this.renderActive(out, cursor, offset);
      cursor = offset;
      const v = ev.mono ? 0 : this.allocate();
      this.voices[v].noteOn(ev.freq, ev.velocity, ev.gateFrames);
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    this.renderActive(out, cursor, frames);
  }

  private allocate(): number {
    for (let v = 0; v < VOICE_COUNT; v++) this.activeScratch[v] = this.voices[v].active;
    const v = pickVoice(this.activeScratch, this.ages, this.rr);
    this.rr = (v + 1) % VOICE_COUNT;
    this.ages[v] = this.ageCounter++;
    return v;
  }

  private renderActive(out: Float32Array, from: number, to: number): void {
    if (to <= from) return;
    for (const voice of this.voices) {
      if (voice.active) voice.renderAdd(out, from, to); // gating: idle voices cost nothing
    }
  }
}
