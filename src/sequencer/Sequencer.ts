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

  start(callback: (step: Step) => void) {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    // Convert BPM to 16th note interval (ms)
    // 60 / BPM = beat duration (s)
    // beat duration / 4 = 16th note duration
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
