// Linear-power split of the averaged magnitude spectrum into three bands.
// Edges per the audit spec: 20-200Hz (lo), 200-2000Hz (mid), 2000Hz-Nyquist (hi).
// Bins below 20Hz are excluded (DC / sub-audio garbage would swamp `lo`).
export interface BandRatios { lo: number; mid: number; hi: number }

export function bandEnergyRatio(averageMagnitudeDb: ReadonlyArray<number>, binHz: number): BandRatios {
  let lo = 0, mid = 0, hi = 0;
  for (let b = 0; b < averageMagnitudeDb.length; b++) {
    const hz = b * binHz;
    if (hz < 20) continue;
    const p = Math.pow(10, averageMagnitudeDb[b] / 10);
    if (hz < 200) lo += p;
    else if (hz < 2000) mid += p;
    else hi += p;
  }
  const total = lo + mid + hi;
  if (total <= 0) return { lo: 0, mid: 0, hi: 0 };
  return { lo: lo / total, mid: mid / total, hi: hi / total };
}
