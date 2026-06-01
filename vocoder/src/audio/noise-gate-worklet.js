// ============================================================================
// noise-gate-worklet.js
// ----------------------------------------------------------------------------
// Noise gate with proper open/close hysteresis + a hold timer.
//
// Why hysteresis matters here:
//   The previous single-threshold design chopped speech between syllables.
//   Voice envelopes dip into the 5-10 dB range below the average level
//   constantly (inter-syllable pauses, soft consonant transitions). A single
//   threshold means every dip closes the gate, which sounds like the voice
//   getting hacked up.
//
// State machine per sample:
//
//   env (one-pole smoothed |x|)
//      │
//      ▼
//   isOpen?
//     ├─ true:
//     │     env >= closeLin?
//     │       ├─ true: reset hold timer
//     │       └─ false:
//     │            hold > 0?
//     │              ├─ true: hold--
//     │              └─ false: isOpen = false
//     └─ false:
//           env >= openLin?
//             ├─ true: isOpen = true; charge hold
//             └─ false: stay closed
//
//   target = isOpen ? 1 : 0
//   gain = smoothed toward target with attack/release coefficients
//   out  = x * gain
//
// Defaults match speech work in real rooms: open at -45 dB (typical voice
// presence), close at -55 dB (rejects room background), hold 250 ms (long
// enough to bridge inter-syllable pauses but short enough to chop trailing
// silences when you stop talking).
// ============================================================================

class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Open threshold (dBFS): env above this opens the gate immediately.
      {
        name: 'openDb',
        defaultValue: -45,
        minValue: -80,
        maxValue: 0,
        automationRate: 'k-rate',
      },
      // Close threshold (dBFS): env must drop below this AND stay below for
      // `hold` seconds before the gate begins releasing. Must be <= openDb.
      {
        name: 'closeDb',
        defaultValue: -55,
        minValue: -80,
        maxValue: 0,
        automationRate: 'k-rate',
      },
      // Hold time in seconds. Re-armed every time env crosses back above
      // closeDb. This is what bridges inter-syllable pauses.
      {
        name: 'hold',
        defaultValue: 0.25,
        minValue: 0,
        maxValue: 5,
        automationRate: 'k-rate',
      },
      {
        name: 'attack',
        defaultValue: 0.005,
        minValue: 0.0001,
        maxValue: 0.5,
        automationRate: 'k-rate',
      },
      {
        name: 'release',
        defaultValue: 0.08,
        minValue: 0.001,
        maxValue: 5,
        automationRate: 'k-rate',
      },
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
    this.env = 0;              // smoothed |x|
    this.gain = 0;             // current gate gain (0..1, smoothed)
    this.isOpen = false;       // state-machine flag
    this.holdRemaining = 0;    // samples left of hold time
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

    const openLin = Math.pow(10, parameters.openDb[0] / 20);
    // Clamp closeDb <= openDb so the hysteresis is always well-defined.
    const closeDbClamped = Math.min(parameters.closeDb[0], parameters.openDb[0]);
    const closeLin = Math.pow(10, closeDbClamped / 20);

    const holdSamplesFull = Math.max(0, Math.round(parameters.hold[0] * sampleRate));
    const envCoef = 1 - Math.exp(-1 / (sampleRate * parameters.envSmooth[0]));
    const attackCoef = 1 - Math.exp(-1 / (sampleRate * parameters.attack[0]));
    const releaseCoef = 1 - Math.exp(-1 / (sampleRate * parameters.release[0]));

    let env = this.env;
    let gain = this.gain;
    let isOpen = this.isOpen;
    let holdRemaining = this.holdRemaining;

    const n = inCh.length;
    for (let i = 0; i < n; i++) {
      const x = inCh[i];
      const absX = x < 0 ? -x : x;
      env += envCoef * (absX - env);

      // State transitions
      if (isOpen) {
        if (env >= closeLin) {
          // Above close threshold (incl. the hysteresis band): refill hold.
          holdRemaining = holdSamplesFull;
        } else {
          // Below close threshold: either hold or release.
          if (holdRemaining > 0) {
            holdRemaining--;
          } else {
            isOpen = false;
          }
        }
      } else {
        // Closed: only an excursion above the OPEN threshold opens us.
        if (env >= openLin) {
          isOpen = true;
          holdRemaining = holdSamplesFull;
        }
      }

      // Smooth gain toward state target (asymmetric attack/release).
      const target = isOpen ? 1 : 0;
      const coef = target > gain ? attackCoef : releaseCoef;
      gain += coef * (target - gain);

      outCh[i] = x * gain;
    }

    // Denormal flush.
    this.env = env < 1e-12 ? 0 : env;
    this.gain = gain < 1e-12 ? 0 : gain;
    this.isOpen = isOpen;
    this.holdRemaining = holdRemaining;

    return true;
  }
}

registerProcessor('noise-gate', NoiseGateProcessor);
