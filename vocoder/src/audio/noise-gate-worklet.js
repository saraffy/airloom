// ============================================================================
// noise-gate-worklet.js
// ----------------------------------------------------------------------------
// AudioWorkletProcessor that mutes its input when the smoothed amplitude
// envelope is below a tunable threshold. Used to keep room noise from
// driving the vocoder when the user isn't speaking.
//
// Pipeline per sample:
//
//   x ──> [|x|] ──> [one-pole smoother, ~20ms] ──> env
//   env > thresholdLinear? ──> target = 1 else 0
//   gain += coef * (target - gain)   (asymmetric: attack vs release)
//   out = x * gain
//
// Thresholds are specified in dBFS (-45 dB ~ 0.0056 linear). The gate gain
// is smooth (not hard 0/1) so opening/closing doesn't click.
//
// Latency: ~envSmoothSec + attackSec (~25 ms at defaults). Acceptable for
// voice -- vowels are >50 ms and consonants are typically louder than
// background noise anyway.
// ============================================================================

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Threshold in dBFS. -45 ≈ quiet room background; -30 ≈ normal speech.
      {
        name: 'threshold',
        defaultValue: -45,
        minValue: -80,
        maxValue: 0,
        automationRate: 'k-rate',
      },
      // Gate-open ramp time. Short so speech onsets aren't chopped.
      {
        name: 'attack',
        defaultValue: 0.005,
        minValue: 0.0001,
        maxValue: 0.5,
        automationRate: 'k-rate',
      },
      // Gate-close ramp time. Longer to let trailing decays through and to
      // bridge inter-syllable gaps.
      {
        name: 'release',
        defaultValue: 0.1,
        minValue: 0.001,
        maxValue: 5,
        automationRate: 'k-rate',
      },
      // Smoothing time on the input envelope detector itself.
      {
        name: 'envSmooth',
        defaultValue: 0.020,
        minValue: 0.001,
        maxValue: 1,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    this.env = 0;   // smoothed |x|
    this.gain = 0;  // current gate gain
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }
    const inCh = input[0];
    const outCh = output[0];
    if (!inCh || !outCh) return true;

    const threshDb = parameters.threshold[0];
    const threshLin = Math.pow(10, threshDb / 20);
    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const envSec = parameters.envSmooth[0];

    const envCoef = 1 - Math.exp(-1 / (sampleRate * envSec));
    const attackCoef = 1 - Math.exp(-1 / (sampleRate * attack));
    const releaseCoef = 1 - Math.exp(-1 / (sampleRate * release));

    let env = this.env;
    let gain = this.gain;
    const n = inCh.length;

    for (let i = 0; i < n; i++) {
      const x = inCh[i];
      const absX = x < 0 ? -x : x;

      env += envCoef * (absX - env);

      const target = env >= threshLin ? 1 : 0;
      const coef = target > gain ? attackCoef : releaseCoef;
      gain += coef * (target - gain);

      outCh[i] = x * gain;
    }

    // Denormal flush so the smoother states don't dribble forever near zero.
    this.env = env < 1e-12 ? 0 : env;
    this.gain = gain < 1e-12 ? 0 : gain;

    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
