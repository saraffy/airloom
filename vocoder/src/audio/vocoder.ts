// ============================================================================
// vocoder.ts -- N-band channel vocoder.
// ----------------------------------------------------------------------------
// Topology (one band shown; we build N of these in parallel):
//
//   modulator (mic) ──> BPF[b] ──> envelope-follower-worklet ──┐
//                                                              │ (audio-rate gain)
//                                                              ▼
//   carrier (synth) ──> BPF[b] ──> GainNode[b].gain ◄──────────┘
//                                       │
//                                       └──> internalSum ──> gateGain ──> output
//   modulator (mic) ──> dryGain ──────────────^                ^
//                                                              │
//                                          master gate (mute/unmute), driven
//                                          by setGate(open) -- one switch
//                                          covers BOTH the vocoded carrier
//                                          path and the dry mic blend so
//                                          "hand down" = total silence.
//
// Why an AudioWorklet for the envelope follower?
//   - Audio-rate gain modulation requires the envelope to be a real audio
//     signal (so it can drive GainNode.gain via the AudioNode->AudioParam
//     connection rule). Web Audio doesn't have a built-in envelope-follower
//     node, but a tiny worklet does the job with sub-millisecond latency
//     and no ScriptProcessorNode-style glitches.
//
// Why bandpass on the CARRIER too?
//   - A pure VCA on the unfiltered carrier would smear voice formants into
//     a single broadband level. By bandpassing the carrier the same way as
//     the modulator, each band scales only the carrier energy in *that*
//     spectral region -- which is what makes the carrier "speak".
// ============================================================================

// Import the worklet source as a URL. Vite serves the .js file in dev and
// places a hashed copy in dist/ for production builds.
import envelopeFollowerUrl from './envelope-follower-worklet.js?url';

export interface VocoderOptions {
  /**
   * Number of bands. More bands = finer formant resolution (better vowel
   * discrimination) at proportionally more CPU. 16 is the spec minimum;
   * 24 is the sweet spot for intelligible speech.
   */
  bands?: number;
  /** Lowest band center frequency (Hz). */
  lowHz?: number;
  /** Highest band center frequency (Hz). */
  highHz?: number;
  /**
   * Bandpass Q for both modulator and carrier filters. Higher = narrower
   * bands (more characteristic vocoder rasp, but blurs vowels). Lower =
   * wider bands (softer / less robotic, but vowels also blur).
   */
  q?: number;
  /**
   * Envelope follower attack time (sec). Short = transients (consonants)
   * punch through cleanly.
   */
  attackSec?: number;
  /**
   * Envelope follower release time (sec). Short = spectral envelope tracks
   * fast-moving vowels without smearing. Too short = "pumping" / amplitude
   * modulation artefacts. ~10-20ms works well for speech.
   */
  releaseSec?: number;
  /**
   * Dry mic level mixed into output (0..1). A small amount of unprocessed
   * voice adds naturalness and improves intelligibility without breaking
   * the vocoder effect. Try 0.0 for pure robot, 0.1-0.2 for "natural robot",
   * 0.3+ for "doubled voice".
   */
  dryMix?: number;
  /**
   * Pre-compressor output gain. Higher values feed the compressor harder,
   * raising perceived loudness. Pair with `makeupGain` to taste.
   */
  outputGain?: number;
  /**
   * Post-compressor makeup gain. Compensates for the level reduction caused
   * by compression. Typical range 1.0..2.0. Combined with `outputGain` this
   * is the main loudness knob.
   */
  makeupGain?: number;
}

const DEFAULTS: Required<VocoderOptions> = {
  bands: 24,
  lowHz: 80,
  highHz: 8000,
  q: 5,
  attackSec: 0.005,
  releaseSec: 0.020,
  dryMix: 0.12,
  outputGain: 5.0,
  makeupGain: 1.3,
};

/**
 * Compute N logarithmically-spaced band center frequencies between lowHz and
 * highHz (inclusive). With N=16, lowHz=80, highHz=8000 you get bands at
 * 80, ~113, ~160, ..., 8000 Hz.
 */
export function logSpacedBands(lowHz: number, highHz: number, n: number): number[] {
  const out: number[] = [];
  const ratio = highHz / lowHz;
  for (let i = 0; i < n; i++) {
    out.push(lowHz * Math.pow(ratio, i / (n - 1)));
  }
  return out;
}

export class Vocoder {
  readonly ctx: AudioContext;
  /** Connect the modulator (e.g. mic) signal here. */
  readonly modulatorIn: GainNode;
  /** Connect the carrier (e.g. synth) signal here. */
  readonly carrierIn: GainNode;
  /** Final vocoded output. Connect this to destination or master FX chain. */
  readonly output: GainNode;
  /** Per-band center frequencies (Hz), exposed for UI/debug. */
  readonly bandFreqs: number[];

  private readonly opts: Required<VocoderOptions>;
  private readonly envNodes: AudioWorkletNode[] = [];
  private readonly vcaNodes: GainNode[] = [];
  private readonly dryGain: GainNode;
  /** Internal accumulation bus where wet bands AND the dry blend land. */
  private readonly internalSum: GainNode;
  /** Master gate. 0 = silent, 1 = pass. setGate() ramps this. */
  private readonly gateGain: GainNode;
  /** Smooths dynamics so the average gets a louder makeup boost. */
  private readonly compressor: DynamicsCompressorNode;
  private readonly makeupGain: GainNode;
  /** Brickwall safety limiter at -1 dB before the exposed output. */
  private readonly limiter: DynamicsCompressorNode;

  private constructor(ctx: AudioContext, opts: Required<VocoderOptions>) {
    this.ctx = ctx;
    this.opts = opts;

    this.modulatorIn = ctx.createGain();
    this.modulatorIn.gain.value = 1;
    this.carrierIn = ctx.createGain();
    this.carrierIn.gain.value = 1;

    // ---- Output chain ------------------------------------------------
    //   internalSum (outputGain trim)
    //     -> gateGain (0 or 1)
    //     -> compressor   (4:1, -18 dB threshold, soft knee)
    //     -> makeupGain   (compensates for compression)
    //     -> limiter      (-1 dB brickwall, prevents clipping)
    //     -> output       (exposed port)
    // Splitting these means the master gate sits AFTER the dry-mix sum,
    // so a closed gate silences everything together (vocoded + dry); and
    // the makeup chain runs on the gated signal so we don't waste
    // headroom on amplifying silence.
    this.internalSum = ctx.createGain();
    this.internalSum.gain.value = opts.outputGain;

    this.gateGain = ctx.createGain();
    this.gateGain.gain.value = 0;
    this.internalSum.connect(this.gateGain);

    // Moderate compressor: smooths the dynamic range so makeupGain can
    // raise the average level without driving peaks into the limiter.
    this.compressor = ctx.createDynamicsCompressor();
    this.compressor.threshold.value = -18;
    this.compressor.knee.value = 12;
    this.compressor.ratio.value = 4;
    this.compressor.attack.value = 0.003;
    this.compressor.release.value = 0.15;
    this.gateGain.connect(this.compressor);

    this.makeupGain = ctx.createGain();
    this.makeupGain.gain.value = opts.makeupGain;
    this.compressor.connect(this.makeupGain);

    // Brickwall safety: high ratio + zero knee + fast attack acts as a
    // peak limiter. Keeps the final output below 0 dBFS even if
    // compressor + makeupGain overshoot transiently.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;
    this.makeupGain.connect(this.limiter);

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.limiter.connect(this.output);

    // Dry mic blend joins the internal sum (so it gets gated too).
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = opts.dryMix;
    this.modulatorIn.connect(this.dryGain);
    this.dryGain.connect(this.internalSum);

    this.bandFreqs = logSpacedBands(opts.lowHz, opts.highHz, opts.bands);
  }

  /**
   * Async factory: registers the envelope-follower AudioWorklet module
   * (idempotent -- subsequent calls are cheap no-ops) then constructs the
   * full band graph.
   */
  static async create(ctx: AudioContext, opts: VocoderOptions = {}): Promise<Vocoder> {
    const merged: Required<VocoderOptions> = { ...DEFAULTS, ...opts };
    await ctx.audioWorklet.addModule(envelopeFollowerUrl);

    const v = new Vocoder(ctx, merged);
    v.buildBands();
    return v;
  }

  private buildBands(): void {
    const { ctx, opts, modulatorIn, carrierIn, internalSum, bandFreqs } = this;

    for (let i = 0; i < bandFreqs.length; i++) {
      const freq = bandFreqs[i]!;

      // --- Modulator chain: BPF -> envelope-follower worklet -----------
      const modBP = ctx.createBiquadFilter();
      modBP.type = 'bandpass';
      modBP.frequency.value = freq;
      modBP.Q.value = opts.q;
      modulatorIn.connect(modBP);

      const env = new AudioWorkletNode(ctx, 'envelope-follower', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete',
      });
      // Default attack/release/gain from the worklet's parameter descriptors;
      // override here so callers can tune per-build.
      env.parameters.get('attack')!.value = opts.attackSec;
      env.parameters.get('release')!.value = opts.releaseSec;
      env.parameters.get('gain')!.value = 1.0;
      modBP.connect(env);
      this.envNodes.push(env);

      // --- Carrier chain: BPF -> VCA (modulated by env) ----------------
      const carBP = ctx.createBiquadFilter();
      carBP.type = 'bandpass';
      carBP.frequency.value = freq;
      carBP.Q.value = opts.q;
      carrierIn.connect(carBP);

      const vca = ctx.createGain();
      // Start silent; the envelope follower drives this up when modulator
      // energy is present.
      vca.gain.value = 0;
      carBP.connect(vca);

      // Audio-rate gain modulation: env output is summed into vca.gain.
      // This is the key trick that makes the vocoder work.
      env.connect(vca.gain);

      vca.connect(internalSum);
      this.vcaNodes.push(vca);
    }
  }

  /**
   * Open or close the master output gate. Smooth-ramped so it doesn't click.
   * This sits AFTER the wet+dry sum, so a closed gate silences both paths.
   */
  setGate(open: boolean): void {
    const target = open ? 1 : 0;
    // Fast attack, slightly slower release -- matches a typical envelope feel
    // and helps avoid clicks on rapid pinch toggles.
    const tc = open ? 0.005 : 0.020;
    this.gateGain.gain.setTargetAtTime(target, this.ctx.currentTime, tc);
  }

  /**
   * Bulk-set the envelope follower attack time across all bands. Useful for
   * tweaking intelligibility (shorter = more transient detail, longer = smoother).
   */
  setAttack(sec: number): void {
    for (const env of this.envNodes) {
      env.parameters.get('attack')!.setTargetAtTime(sec, this.ctx.currentTime, 0.01);
    }
  }

  /** Bulk-set the envelope follower release time across all bands. */
  setRelease(sec: number): void {
    for (const env of this.envNodes) {
      env.parameters.get('release')!.setTargetAtTime(sec, this.ctx.currentTime, 0.01);
    }
  }

  /** Set the dry-mic blend level (0..1). Smooth-ramps to avoid clicks. */
  setDryMix(level: number): void {
    this.dryGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
  }

  /** Set the post-compressor makeup gain. */
  setMakeupGain(g: number): void {
    this.makeupGain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
  }

  /** Current compressor reduction in dB (positive number = amount of reduction). */
  getCompressorReductionDb(): number {
    // .reduction is a negative dB number (e.g. -6 means 6 dB of reduction).
    return -this.compressor.reduction;
  }
}
