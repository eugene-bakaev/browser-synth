export interface Step {
  note: string | null;
  octave: number;
  length: number; // Duration in ticks (16th notes)
}

export class Sequencer {
  steps: Step[] = Array(16).fill(null).map(() => ({ note: null, octave: 4, length: 1 }));
  bpm = 120;
  private currentStep = 0;
  private timer: any = null;
  isPlaying = false;
  private nextNoteTime = 0;

  start(ctx: AudioContext, callback: (step: Step, time: number) => void) {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    this.currentStep = 0;
    this.nextNoteTime = ctx.currentTime + 0.1; // Start slightly in the future to absorb JS jitter
    
    // Check every 25ms to see if a note needs to be scheduled
    this.timer = setInterval(() => {
      const stepTime = (60 / this.bpm) / 4;
      
      // Lookahead window of 0.1 seconds
      while (this.nextNoteTime < ctx.currentTime + 0.1) {
        callback(this.steps[this.currentStep], this.nextNoteTime);
        this.currentStep = (this.currentStep + 1) % 16;
        this.nextNoteTime += stepTime;
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
