// Shared sample-buffer shape for the whole lab: every renderer produces it,
// every analyzer consumes it. Mono by contract in Phase 1 (kernels are mono;
// Tier 2 stereo is a spec-deferred follow-up).
export interface AudioClip {
  samples: Float32Array;
  sampleRate: number;
}

export const DEFAULT_SAMPLE_RATE = 48000;
