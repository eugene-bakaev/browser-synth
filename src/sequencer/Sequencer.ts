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

export class Sequencer {
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
  private currentStep = 0;
  private timer: any = null;
  isPlaying = false;
  // Absolute count of steps scheduled since the last anchor (used to compute
  // step times without floating-point drift over thousands of steps).
  private nextStepIndex = 0;
  // Anchor: the audio-clock time at which scheduleStartTime + 0*stepTime = step 0.
  private scheduleStartTime = 0;
  // Last BPM we observed; used to detect mid-playback tempo changes.
  private lastBpm = 120;

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

    this.currentStep = 0;
    this.nextStepIndex = 0;
    this.scheduleStartTime = ctx.currentTime + 0.1; // 0.1s lookahead absorbs JS jitter
    this.lastBpm = this.bpm;

    // Check every 25ms to see if a note needs to be scheduled
    this.timer = setInterval(() => {
      // If BPM changed mid-play, rebase the anchor to the last scheduled step's
      // time so the very next step uses the new stepTime forward — feels like
      // "tempo takes effect immediately" rather than a one-step delay.
      if (this.bpm !== this.lastBpm) {
        if (this.nextStepIndex > 0) {
          const oldStepTime = (60 / this.lastBpm) / 4;
          const lastScheduledTime = this.scheduleStartTime + (this.nextStepIndex - 1) * oldStepTime;
          this.scheduleStartTime = lastScheduledTime;
          this.nextStepIndex = 1;
        }
        this.lastBpm = this.bpm;
      }

      const stepTime = (60 / this.bpm) / 4;
      const lookaheadTime = ctx.currentTime + 0.1;

      // Compute next step time from the anchor + integer step count (no float drift)
      let nextStepTime = this.scheduleStartTime + this.nextStepIndex * stepTime;
      while (nextStepTime < lookaheadTime) {
        callback(this.currentStep, nextStepTime);
        this.currentStep = (this.currentStep + 1) % 16;
        this.nextStepIndex += 1;
        nextStepTime = this.scheduleStartTime + this.nextStepIndex * stepTime;
      }
    }, 25);
  }

  stop() {
    this.isPlaying = false;
    if (this.timer) {
        clearInterval(this.timer);
        this.timer = null;
    }
  }
}
