// Oscillation depth of a per-frame metric series (RMS dB, centroid Hz, f0 Hz)
// after removing a linear trend: depth = (p95 - p5)/2 of the residual, rate
// from residual zero crossings. Nulls (unvoiced/silent frames) are skipped.
export interface ModDepthResult { depth: number | null; rateHz: number | null }

export function modDepth(series: ReadonlyArray<number | null>, stepSeconds: number): ModDepthResult {
  const idx: number[] = [];
  const val: number[] = [];
  series.forEach((v, i) => {
    if (v != null && Number.isFinite(v)) { idx.push(i); val.push(v); }
  });
  const n = val.length;
  if (n < 8) return { depth: null, rateHz: null };

  const mx = idx.reduce((a, b) => a + b, 0) / n;
  const my = val.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sxx += (idx[i] - mx) ** 2; sxy += (idx[i] - mx) * (val[i] - my); }
  const slope = sxx > 0 ? sxy / sxx : 0;
  const resid = val.map((v, i) => v - (my + slope * (idx[i] - mx)));

  const sorted = [...resid].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))))];
  const depth = (q(0.95) - q(0.05)) / 2;

  let crossings = 0;
  for (let i = 1; i < n; i++) {
    if ((resid[i - 1] < 0 && resid[i] >= 0) || (resid[i - 1] >= 0 && resid[i] < 0)) crossings++;
  }
  const duration = (idx[n - 1] - idx[0]) * stepSeconds;
  const rateHz = crossings >= 2 && duration > 0 ? crossings / 2 / duration : null;
  return { depth, rateHz };
}
