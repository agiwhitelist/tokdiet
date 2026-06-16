// src/quality/ledger.ts — small rolling-window aggregates for quality stats.

/**
 * Fixed-capacity rolling window of numeric samples. Keeps only the most recent
 * `maxN` values; `avg()` returns the mean of what's currently held (null when
 * empty).
 */
export class RollingAverage {
  private readonly maxN: number;
  private readonly buf: number[] = [];

  constructor(maxN: number) {
    // Guard against zero/negative/NaN capacities — keep at least one slot.
    this.maxN = Number.isFinite(maxN) && maxN >= 1 ? Math.floor(maxN) : 1;
  }

  /** Append a sample, evicting the oldest once capacity is exceeded. Ignores non-finite values. */
  push(v: number): void {
    if (!Number.isFinite(v)) return;
    this.buf.push(v);
    if (this.buf.length > this.maxN) this.buf.shift();
  }

  /** Mean of held samples, or null when empty. */
  avg(): number | null {
    if (this.buf.length === 0) return null;
    let sum = 0;
    for (const v of this.buf) sum += v;
    return sum / this.buf.length;
  }

  /** Number of samples currently held. */
  count(): number {
    return this.buf.length;
  }
}
