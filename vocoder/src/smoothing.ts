// ============================================================================
// smoothing.ts -- One-Euro Filter for noisy gesture signals.
// ----------------------------------------------------------------------------
// The One-Euro Filter (Casiez, Roussel, Vogel 2012) is a low-pass with an
// ADAPTIVE cutoff: it smooths heavily when the input is slow (kills jitter
// while a hand is held still) and lightly when the input is fast (no lag
// during deliberate motion).
//
// We use it on every continuous mapped value (right wristY for pitch, left
// openness for wet/dry, two-hand distance for reverb send) so the audio
// doesn't zipper between video frames.
//
// Math (per sample):
//   dt = current_time - prev_time
//   raw_d = (value - prev_value) / dt                  # instant derivative
//   alpha_d = 1 / (1 + tau(dCutoff) / dt)              # smoother for d
//   d = prev_d + alpha_d * (raw_d - prev_d)            # smoothed derivative
//
//   cutoff = minCutoff + beta * |d|                    # ADAPTIVE part
//   alpha = 1 / (1 + tau(cutoff) / dt)
//   filtered = prev_value + alpha * (value - prev_value)
//
//   tau(f) = 1 / (2 * pi * f)
//
// Tuning:
//   minCutoff -- baseline cutoff when stationary. Lower = more smoothing
//                at rest. 0.5-1.5 Hz works well for hand tracking at 30 fps.
//   beta      -- how aggressively cutoff opens with speed. Higher = less
//                lag during motion. 0.01-1.0 depending on application.
//   dCutoff   -- cutoff for the derivative-of-the-derivative estimate. 1 Hz
//                is a near-universal default.
// ============================================================================

export interface OneEuroFilterOptions {
  /** Minimum cutoff frequency in Hz (smoothing at rest). */
  minCutoff?: number;
  /** Speed coefficient (Hz per unit-per-second of derivative). */
  beta?: number;
  /** Cutoff for the derivative estimate (Hz). */
  dCutoff?: number;
}

const DEFAULTS: Required<OneEuroFilterOptions> = {
  minCutoff: 1.0,
  beta: 0.1,
  dCutoff: 1.0,
};

export class OneEuroFilter {
  private readonly opts: Required<OneEuroFilterOptions>;
  private prevValue: number | null = null;
  private prevDeriv = 0;
  private prevTimeSec = 0;

  constructor(opts: OneEuroFilterOptions = {}) {
    this.opts = { ...DEFAULTS, ...opts };
  }

  filter(value: number, timeMs: number): number {
    const timeSec = timeMs / 1000;
    if (this.prevValue === null) {
      this.prevValue = value;
      this.prevTimeSec = timeSec;
      return value;
    }
    // Clamp dt to avoid divide-by-zero or absurd alphas after a long pause.
    const dt = Math.min(0.5, Math.max(0.001, timeSec - this.prevTimeSec));
    this.prevTimeSec = timeSec;

    // Instantaneous derivative, smoothed with a fixed-cutoff filter.
    const rawDeriv = (value - this.prevValue) / dt;
    const dAlpha = OneEuroFilter.alpha(this.opts.dCutoff, dt);
    const deriv = this.prevDeriv + dAlpha * (rawDeriv - this.prevDeriv);
    this.prevDeriv = deriv;

    // Adaptive cutoff: higher when moving fast, lower when stationary.
    const cutoff = this.opts.minCutoff + this.opts.beta * Math.abs(deriv);
    const vAlpha = OneEuroFilter.alpha(cutoff, dt);
    const filtered = this.prevValue + vAlpha * (value - this.prevValue);
    this.prevValue = filtered;
    return filtered;
  }

  /** Forget all history. Use when the input stream is interrupted. */
  reset(): void {
    this.prevValue = null;
    this.prevDeriv = 0;
  }

  private static alpha(cutoff: number, dt: number): number {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

/**
 * Map a value linearly from [inMin, inMax] to [outMin, outMax], clamped.
 * Used everywhere we need to translate a smoothed gesture value into an
 * audio-parameter range.
 */
export function mapRange(
  v: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
): number {
  if (inMax === inMin) return outMin;
  const t = (v - inMin) / (inMax - inMin);
  const tc = Math.max(0, Math.min(1, t));
  return outMin + tc * (outMax - outMin);
}
