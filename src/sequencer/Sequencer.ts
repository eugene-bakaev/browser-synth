export interface Step {
  note: string | null;
  octave: number;
  length: number; // Duration in ticks (16th notes)
  velocity: number; // Volume velocity (0.0 - 1.0)
  muted: boolean; // Step mute state
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
      muted: false
    }))
  }));
  bpm = 120;
  private currentStep = 0;
  private timer: any = null;
  isPlaying = false;
  private nextNoteTime = 0;

  clearTrack(trackId: number) {
    const track = this.tracks.find(t => t.id === trackId);
    if (!track) return;
    track.steps.forEach(step => {
      step.note = null;
      step.muted = false;
      step.velocity = 0.8;
      step.octave = 4;
      step.length = 1;
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
      }
    });
  }


  start(ctx: AudioContext, callback: (stepIndex: number, time: number) => void) {
    if (this.isPlaying) return;
    this.isPlaying = true;
    
    this.currentStep = 0;
    this.nextNoteTime = ctx.currentTime + 0.1; // Start slightly in the future to absorb JS jitter
    
    // Check every 25ms to see if a note needs to be scheduled
    this.timer = setInterval(() => {
      const stepTime = (60 / this.bpm) / 4;
      
      // Lookahead window of 0.1 seconds
      while (this.nextNoteTime < ctx.currentTime + 0.1) {
        callback(this.currentStep, this.nextNoteTime);
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
