/**
 * Shared event loop lag statistics computation.
 * Used by both the renderer and server perf monitors.
 */

export interface LagStats {
  avg: number;
  max: number;
}

/** Compute avg/max from a Float64Array ring buffer. Returns null if no samples. */
export function computeLagStats(
  samples: Float64Array,
  sampleCount: number,
  ringSize: number,
): LagStats | null {
  if (sampleCount === 0) return null;
  const count = Math.min(sampleCount, ringSize);
  let sum = 0;
  let max = 0;
  for (let i = 0; i < count; i++) {
    const v = samples[i]!;
    sum += v;
    if (v > max) max = v;
  }
  return { avg: Math.round((sum / count) * 100) / 100, max: Math.round(max * 100) / 100 };
}
