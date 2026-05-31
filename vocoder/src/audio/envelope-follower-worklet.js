// ============================================================================
// envelope-follower-worklet.js
// ----------------------------------------------------------------------------
// AudioWorkletProcessor that follows the amplitude envelope of an audio
// signal. This is the "modulator" half of each vocoder band:
//
//   filtered modulator (mic) -> [|x|] -> [one-pole smoother] -> envelope
//
// The output is an audio-rate signal (one value per sample) representing
// the instantaneous smoothed amplitude. Downstream, we connect this node's
// output directly to a GainNode's .gain AudioParam, which causes the
// envelope to modulate the carrier-band gain at audio rate. No glitches,
// no zippering, no ScriptProcessorNode.
//
// Smoother math:
//   For each sample x:
//     y += coef * (|x| - y)
//   where coef = 1 - exp(-1 / (sampleRate * timeConstant))
//
//   We use two coefficients -- a faster one when |x| > y (attack, so
//   transients aren't smeared) and a slower one when |x| <= y (release,
//   so the output doesn't quack between syllables). This is the standard
//   asymmetric envelope-follower design.
// ============================================================================

class EnvelopeFollowerProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // Attack/release in seconds. k-rate is fine: these don't need to
      // change every sample, and reading params[0] once per render quantum
      // keeps the inner loop tight.
      {
        name: 'attack',
        defaultValue: 0.005,
        minValue: 0.0001,
        maxValue: 1.0,
        automationRate: 'k-rate',
      },
      {
        name: 'release',
        defaultValue: 0.020,
        minValue: 0.0001,
        maxValue: 1.0,
        automationRate: 'k-rate',
      },
      // Output gain trim. Useful per-band to compensate for bandpass
      // attenuation at the extremes.
      {
        name: 'gain',
        defaultValue: 1.0,
        minValue: 0.0,
        maxValue: 64.0,
        automationRate: 'k-rate',
      },
    ];
  }

  constructor() {
    super();
    // Smoother state: last output sample. Persists across render quanta so
    // there's no envelope reset at the 128-sample boundary.
    this.state = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];

    // Nothing connected yet, or output not available -- keep alive.
    if (!input || input.length === 0 || !output || output.length === 0) {
      return true;
    }

    const inCh = input[0];
    const outCh = output[0];
    if (!inCh || !outCh) return true;

    const attack = parameters.attack[0];
    const release = parameters.release[0];
    const gain = parameters.gain[0];

    // One-pole coefficients. sampleRate is a global available in the
    // AudioWorklet scope.
    const aCoef = 1 - Math.exp(-1 / (sampleRate * attack));
    const rCoef = 1 - Math.exp(-1 / (sampleRate * release));

    let s = this.state;
    const n = inCh.length;
    for (let i = 0; i < n; i++) {
      const x = inCh[i] < 0 ? -inCh[i] : inCh[i]; // |x|, faster than Math.abs
      const coef = x > s ? aCoef : rCoef;
      s += coef * (x - s);
      outCh[i] = s * gain;
    }
    // Denormal flush: when the modulator goes truly silent, s decays
    // exponentially toward zero. Below ~1e-38 (single-precision denormal
    // range) some CPUs slow down dramatically. We zero the state once it's
    // negligibly small. Not a fix for the "held-note breakup" issue
    // (which is upstream in the pitch quantizer), just cheap insurance.
    this.state = s < 1e-12 ? 0 : s;

    return true;
  }
}

registerProcessor('envelope-follower', EnvelopeFollowerProcessor);
