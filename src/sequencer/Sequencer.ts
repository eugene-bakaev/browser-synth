export interface Step {
  note: string | null;
  octave: number;
  length: number; // Duration in ticks (16th notes)
  velocity: number; // Volume velocity (0.0 - 1.0)
  muted: boolean; // Step mute state
  isChord?: boolean;
  chordType?: string;
}

export interface Track {
  id: number;
  name: string;
  steps: Step[];
}

// Scheduler bookkeeping that doesn't need Vue reactivity. Bundled into one
// markRaw'd object so `reactive(new Sequencer())` skips proxying these fields.
// Touched ~7x per setInterval tick — without markRaw that's ~120ms/min of
// pointless proxy-trap overhead during playback. Vue would also wrap `timer`
// (a setInterval return value), which is semantically meaningless.
interface SchedulerInternals {
  currentStep: number;
  timer: any;
  // Absolute count of steps scheduled since the last anchor (lets us compute
  // step times without floating-point drift over thousands of steps).
  nextStepIndex: number;
  // Anchor: the audio-clock time at which scheduleStartTime + 0*stepTime = step 0.
  scheduleStartTime: number;
  // Last BPM observed; used to detect mid-playback tempo changes.
  lastBpm: number;
}

import { markRaw } from 'vue';

export class Sequencer {
  // Public reactive surface — UI binds to these.
  tracks: Track[] = Array(4).fill(null).map((_, index) => ({
    id: index,
    name: `Track ${index + 1}`,
    steps: Array(16).fill(null).map(() => ({
      note: null,
      octave: 4,
      length: 1,
      velocity: 0.8,
      muted: false,
      isChord: false,
      chordType: 'maj'
    }))
  }));
  bpm = 120;
  isPlaying = false;

  // Scheduler internals — non-reactive. Access via `this.internals.X`.
  private internals: SchedulerInternals = markRaw({
    currentStep: 0,
    timer: null,
    nextStepIndex: 0,
    scheduleStartTime: 0,
    lastBpm: 120,
  });

  clearTrack(trackId: number) {
    const track = this.tracks.find(t => t.id === trackId);
    if (!track) return;
    track.steps.forEach(step => {
      step.note = null;
      step.muted = false;
      step.velocity = 0.8;
      step.octave = 4;
      step.length = 1;
      step.isChord = false;
      step.chordType = 'maj';
    });
  }

  shiftTrack(trackId: number, direction: 'left' | 'right') {
    const track = this.tracks.find(t => t.id === trackId);
    if (!track) return;
    if (direction === 'left') {
      const first = track.steps.shift();
      if (first !== undefined) track.steps.push(first);
    } else {
      const last = track.steps.pop();
      if (last !== undefined) track.steps.unshift(last);
    }
  }

  fillTrack(trackId: number, interval: number) {
    const track = this.tracks.find(t => t.id === trackId);
    if (!track) return;
    track.steps.forEach((step, index) => {
      if (index % interval === 0) {
        step.note = 'C';
        step.muted = false;
        step.velocity = 0.8;
        step.isChord = false;
        step.chordType = 'maj';
      }
    });
  }


  start(ctx: AudioContext, callback: (stepIndex: number, time: number) => void) {
    if (this.isPlaying) return;
    this.isPlaying = true;

    const s = this.internals;
    s.currentStep = 0;
    s.nextStepIndex = 0;
    s.scheduleStartTime = ctx.currentTime + 0.1; // 0.1s lookahead absorbs JS jitter
    s.lastBpm = this.bpm;

    // Check every 25ms to see if a note needs to be scheduled
    s.timer = setInterval(() => {
      // If BPM changed mid-play, rebase the anchor to the last scheduled step's
      // time so the very next step uses the new stepTime forward — feels like
      // "tempo takes effect immediately" rather than a one-step delay.
      if (this.bpm !== s.lastBpm) {
        if (s.nextStepIndex > 0) {
          const oldStepTime = (60 / s.lastBpm) / 4;
          const lastScheduledTime = s.scheduleStartTime + (s.nextStepIndex - 1) * oldStepTime;
          s.scheduleStartTime = lastScheduledTime;
          s.nextStepIndex = 1;
        }
        s.lastBpm = this.bpm;
      }

      const stepTime = (60 / this.bpm) / 4;
      const lookaheadTime = ctx.currentTime + 0.1;

      // Compute next step time from the anchor + integer step count (no float drift)
      let nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
      while (nextStepTime < lookaheadTime) {
        callback(s.currentStep, nextStepTime);
        s.currentStep = (s.currentStep + 1) % 16;
        s.nextStepIndex += 1;
        nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
      }
    }, 25);
  }

  stop() {
    this.isPlaying = false;
    const s = this.internals;
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }
}
