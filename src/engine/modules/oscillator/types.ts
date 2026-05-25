// AudioNode + OscillatorType come from lib.dom — no imports needed.

export type OscMode =
  | 'free-run'
  | 'phase-offset'
  | 'retrigger-recreate'
  | 'retrigger-wavetable';

export interface IOscillatorModule {
  readonly outputs: { main: AudioNode };
  setWaveform(type: OscillatorType): void;
  setCoarseTune(octaves: number): void;
  setFineTune(cents: number): void;
  setPhase(degrees: number): void;

  // Steady-state path (free-run, phase-offset): schedule a freq change on the
  // already-running oscillator.
  setFrequencyAtTime(freq: number, time: number): void;

  // Per-trigger path. Free-run / phase-offset implement this as a thin
  // setFrequencyAtTime so SynthVoice.trigger can call triggerAt uniformly.
  // Retrigger / wavetable modes create + start a fresh source here, and
  // schedule stop(releaseTime + 50ms).
  triggerAt(freq: number, time: number, releaseTime: number): void;

  dispose(): void;
}
