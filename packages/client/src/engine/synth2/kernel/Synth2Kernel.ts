//
// Top level (spec §6.2/§6.7): voice pool + sample-accurate event queue +
// block renderer. Pure TS, zero allocation after construction. process(out,
// frames, blockStartFrame) renders audio into out; frames must equal
// out.length (the code trusts frames, not out.length). blockStartFrame is the
// absolute frame the block starts at (the worklet passes currentFrame; tests
// pass whatever they like).
//
// I1 is mono: one voice, every note retriggers it (steal ramp keeps it
// clickless). The queue is a fixed ring of preallocated events — events are
// assumed time-ordered (the sequencer schedules in order); a full ring drops
// the oldest event, which at 64 slots only happens under pathological input.

import { Voice } from './Voice';
import { PARAM_COUNT, defaultParamBlock } from './params';

const MAX_EVENTS = 64;

interface NoteEvent {
  frame: number;
  freq: number;
  gateFrames: number;
  velocity: number;
}

export class Synth2Kernel {
  private readonly voices: Voice[];
  private readonly block: Float32Array = defaultParamBlock();
  private readonly events: NoteEvent[];
  private head = 0; // next event to consume
  private count = 0;

  constructor(private readonly sampleRate: number) {
    this.voices = [new Voice(sampleRate)];
    this.events = Array.from({ length: MAX_EVENTS }, () => ({
      frame: 0, freq: 440, gateFrames: 0, velocity: 1,
    }));
  }

  /** Full param block (base values, descriptor order). Broadcast to voices. */
  applyParams(block: Float32Array): void {
    const n = Math.min(block.length, PARAM_COUNT);
    for (let i = 0; i < n; i++) this.block[i] = block[i];
    for (const voice of this.voices) {
      for (let i = 0; i < n; i++) voice.slots[i].setBase(this.block[i]);
    }
  }

  /** time/duration in seconds on the AudioContext clock (SoundEngine contract). */
  noteOn(time: number, freq: number, duration: number, velocity: number): void {
    if (this.count === MAX_EVENTS) { // drop oldest
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    const ev = this.events[(this.head + this.count) % MAX_EVENTS];
    ev.frame = Math.round(time * this.sampleRate);
    ev.freq = freq;
    ev.gateFrames = Math.max(1, Math.round(duration * this.sampleRate));
    ev.velocity = velocity;
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
      this.voices[0].noteOn(ev.freq, ev.velocity, ev.gateFrames);
      this.head = (this.head + 1) % MAX_EVENTS;
      this.count--;
    }
    this.renderActive(out, cursor, frames);
  }

  private renderActive(out: Float32Array, from: number, to: number): void {
    if (to <= from) return;
    for (const voice of this.voices) {
      if (voice.active) voice.renderAdd(out, from, to); // gating: idle voices cost nothing
    }
  }
}
