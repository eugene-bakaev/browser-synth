// Snare engine param shape and default. Lives in @fiddle/shared so server-side
// code can construct/validate a default Project. SnareEngine imports these back.

export interface SnareEngineParams {
  tune: number;    // Base pitch in Hz (100 - 250)
  decay: number;   // Snare wires decay in seconds (0.05 - 0.8)
  snappy: number;  // Noise level ratio vs body (0.0 - 1.0)
}

export const DEFAULT_SNARE_PARAMS: SnareEngineParams = {
  tune: 180,
  decay: 0.25,
  snappy: 0.5,
};
