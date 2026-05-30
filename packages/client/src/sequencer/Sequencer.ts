import { markRaw } from 'vue';

// Step now lives in @fiddle/shared (canonical wire-format type). Re-export
// here so existing imports `from '../sequencer/Sequencer'` keep resolving.
export type { Step } from '@fiddle/shared';

// Scheduler bookkeeping that doesn't need Vue reactivity. Bundled into one
// markRaw'd object so `reactive(new Sequencer())` skips proxying these fields.
// Touched ~7x per setInterval tick — without markRaw that's ~120ms/min of
// pointless proxy-trap overhead during playback.
interface SchedulerInternals {
  // Monotonic ABSOLUTE step counter (no modulo). Per-track modulo (% patternLength)
  // is applied by the consumer. JS safe-integer range gives ~35M years of headroom
  // at typical step rates.
  currentStep: number;
  timer: any;
  // Count of steps scheduled since the last anchor, used only for time math
  // (not emitted to the consumer — that's currentStep). Lets us compute step
  // times without floating-point drift over thousands of steps.
  nextStepIndex: number;
  // The audio-clock time at which scheduleStartTime + 0*stepTime = step 0.
  scheduleStartTime: number;
  // Last BPM observed; used to detect mid-playback tempo changes.
  lastBpm: number;
}

export class Sequencer {
  // Public reactive surface — UI binds to this.
  isPlaying = false;

  // Scheduler internals — non-reactive. Access via `this.internals.X`.
  private internals: SchedulerInternals = markRaw({
    currentStep: 0,
    timer: null,
    nextStepIndex: 0,
    scheduleStartTime: 0,
    lastBpm: 120,
  });

  start(
    ctx: AudioContext,
    getBpm: () => number,
    onStep: (stepIndex: number, time: number) => void,
  ): void {
    if (this.isPlaying) return;
    this.isPlaying = true;

    const s = this.internals;
    s.currentStep = 0;
    s.nextStepIndex = 0;
    s.scheduleStartTime = ctx.currentTime + 0.1; // 0.1s lookahead absorbs JS jitter
    s.lastBpm = getBpm();

    s.timer = setInterval(() => {
      const bpm = getBpm();
      // If BPM changed mid-play, rebase the anchor to the last scheduled step's
      // time so the very next step uses the new stepTime forward.
      if (bpm !== s.lastBpm) {
        if (s.nextStepIndex > 0) {
          const oldStepTime = (60 / s.lastBpm) / 4;
          const lastScheduledTime = s.scheduleStartTime + (s.nextStepIndex - 1) * oldStepTime;
          s.scheduleStartTime = lastScheduledTime;
          s.nextStepIndex = 1;
        }
        s.lastBpm = bpm;
      }

      const stepTime = (60 / bpm) / 4;
      const lookaheadTime = ctx.currentTime + 0.1;

      let nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
      while (nextStepTime < lookaheadTime) {
        onStep(s.currentStep, nextStepTime);
        s.currentStep = s.currentStep + 1;
        s.nextStepIndex += 1;
        nextStepTime = s.scheduleStartTime + s.nextStepIndex * stepTime;
      }
    }, 25);
  }

  stop(): void {
    this.isPlaying = false;
    const s = this.internals;
    if (s.timer) {
      clearInterval(s.timer);
      s.timer = null;
    }
  }
}
