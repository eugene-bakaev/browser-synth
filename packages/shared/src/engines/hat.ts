// Hat engine param shape and default. Lives in @fiddle/shared so server-side
// code can construct/validate a default Project. HatEngine imports these back.

export interface HatEngineParams {
  decay: number;     // seconds (0.02 - 0.6)
  tone: number;      // bandpass filter cutoff Hz (3000 - 14000)
  metallic: number;  // blend ratio: 0 = noise only, 1 = metal only
}

export const DEFAULT_HAT_PARAMS: HatEngineParams = {
  decay: 0.15,
  tone: 8000,
  metallic: 0.5,
};
