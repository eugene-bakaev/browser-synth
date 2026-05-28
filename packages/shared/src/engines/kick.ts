// Kick engine param shape and default. Lives in @fiddle/shared so server-side
// code can construct/validate a default Project. KickEngine imports these back.

export interface KickEngineParams {
  tune: number;   // Base pitch in Hz (40 - 120)
  decay: number;  // Decay time in seconds (0.05 - 1.5)
  click: number;  // Click depth (0.0 - 1.0)
}

export const DEFAULT_KICK_PARAMS: KickEngineParams = {
  tune: 55,
  decay: 0.3,
  click: 0.5,
};
