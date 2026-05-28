// Clap engine param shape and default. Lives in @fiddle/shared so server-side
// code can construct/validate a default Project. ClapEngine imports these back.

export interface ClapEngineParams {
  decay: number;   // Clap tail decay in seconds (0.05 - 0.8)
  tone: number;    // Bandpass filter cutoff frequency Hz (500 - 3000)
  sloppy: number;  // Spacing between initial impulses (0.005 - 0.03)
}

export const DEFAULT_CLAP_PARAMS: ClapEngineParams = {
  decay: 0.25,
  tone: 1000,
  sloppy: 0.015,
};
