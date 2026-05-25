// Reference Fourier coefficient tables for the four standard waveforms,
// truncated to 32 harmonics (matches PeriodicWave's audible range and keeps
// table size tiny). The PeriodicWave layout requires a 0-DC entry, so each
// array has length 33: index 0 is the DC offset (always 0 for these
// waveforms), indices 1..32 are the k-th harmonic.
//
// (real, imag) follows the PeriodicWave convention:
//   sample(t) = sum_k(real[k] * cos(k * 2π * f * t) + imag[k] * sin(...))

const N = 33;

function makeArrays(): { real: Float32Array; imag: Float32Array } {
  return { real: new Float32Array(N), imag: new Float32Array(N) };
}

function sineCoefficients(): { real: Float32Array; imag: Float32Array } {
  const { real, imag } = makeArrays();
  imag[1] = 1; // single fundamental
  return { real, imag };
}

function sawtoothCoefficients(): { real: Float32Array; imag: Float32Array } {
  // Bandlimited sawtooth: imag[k] = 2/(π*k) * (-1)^(k+1) for k >= 1
  // (matches the standard descending sawtooth shape used by OscillatorNode).
  const { real, imag } = makeArrays();
  for (let k = 1; k < N; k++) {
    imag[k] = (2 / (Math.PI * k)) * ((k % 2 === 1) ? 1 : -1);
  }
  return { real, imag };
}

function squareCoefficients(): { real: Float32Array; imag: Float32Array } {
  // Bandlimited square: imag[k] = 4/(π*k) for odd k, 0 for even.
  const { real, imag } = makeArrays();
  for (let k = 1; k < N; k++) {
    if (k % 2 === 1) imag[k] = 4 / (Math.PI * k);
  }
  return { real, imag };
}

function triangleCoefficients(): { real: Float32Array; imag: Float32Array } {
  // Bandlimited triangle: imag[k] = 8/(π² * k²) * (-1)^((k-1)/2) for odd k.
  const { real, imag } = makeArrays();
  for (let k = 1; k < N; k++) {
    if (k % 2 === 1) {
      imag[k] = (8 / (Math.PI * Math.PI * k * k)) * (((k - 1) / 2) % 2 === 0 ? 1 : -1);
    }
  }
  return { real, imag };
}

const TABLES: Record<OscillatorType, { real: Float32Array; imag: Float32Array }> = {
  sine: sineCoefficients(),
  sawtooth: sawtoothCoefficients(),
  square: squareCoefficients(),
  triangle: triangleCoefficients(),
  // 'custom' is reachable through OscillatorType but our UI never selects it.
  // Fall back to sine so a stale enum value doesn't crash.
  custom: sineCoefficients(),
};

// Returns base coefficients for the given waveform. Caller is responsible for
// passing the result through rotatePhase before handing to PeriodicWave.
export function baseTable(type: OscillatorType): { real: Float32Array; imag: Float32Array } {
  const t = TABLES[type] ?? TABLES.sine;
  // Hand back copies so callers can mutate freely without poisoning the cache.
  return { real: new Float32Array(t.real), imag: new Float32Array(t.imag) };
}

// Rotate each harmonic by k·θ where θ = degrees * π / 180. For the k-th
// harmonic (a, b):
//   real' =  a·cos(kθ) + b·sin(kθ)
//   imag' = -a·sin(kθ) + b·cos(kθ)
// Mutates the input arrays in place and returns them.
export function rotatePhase(
  base: { real: Float32Array; imag: Float32Array },
  degrees: number,
): { real: Float32Array; imag: Float32Array } {
  const theta = (degrees * Math.PI) / 180;
  for (let k = 1; k < base.real.length; k++) {
    const a = base.real[k];
    const b = base.imag[k];
    const c = Math.cos(k * theta);
    const s = Math.sin(k * theta);
    base.real[k] =  a * c + b * s;
    base.imag[k] = -a * s + b * c;
  }
  return base;
}
