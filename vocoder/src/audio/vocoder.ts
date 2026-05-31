// ============================================================================
// vocoder.ts -- 16-band channel vocoder.
// ----------------------------------------------------------------------------
// Topology (one band shown; we build N of these in parallel):
//
//   modulator (mic) ──> BPF[b] ──> envelope-follower-worklet ──┐
//                                                              │ (audio-rate gain)
//                                                              ▼
//   carrier (synth) ──> BPF[b] ──> GainNode[b].gain ◄──────────┘
//                                       │
//                                       └──> sum bus ──> output
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
  /** Number of bands. 16 is the spec default. */
  bands?: number;
  /** Lowest band center frequency (Hz). */
  lowHz?: number;
  /** Highest band center frequency (Hz). */
  highHz?: number;
  /** Bandpass Q for both modulator and carrier filters. Higher = narrower. */
  q?: number;
  /** Envelope follower attack time (sec). */
  attackSec?: number;
  /** Envelope follower release time (sec). */
  releaseSec?: number;
  /** Master output gain compensation. Sum of 16 BPFs is quieter than dry. */
  outputGain?: number;
}

const DEFAULTS: Required<VocoderOptions> = {
  bands: 16,
  lowHz: 80,
  highHz: 8000,
  q: 6,
  attackSec: 0.005,
  releaseSec: 0.025,
  outputGain: 3.0,
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

  private constructor(ctx: AudioContext, opts: Required<VocoderOptions>) {
    this.ctx = ctx;
    this.opts = opts;

    // Input/output hubs let callers connect once without caring about
    // internal topology.
    this.modulatorIn = ctx.createGain();
    this.modulatorIn.gain.value = 1;
    this.carrierIn = ctx.createGain();
    this.carrierIn.gain.value = 1;
    this.output = ctx.createGain();
    this.output.gain.value = opts.outputGain;

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
    const { ctx, opts, modulatorIn, carrierIn, output, bandFreqs } = this;

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

      vca.connect(output);
      this.vcaNodes.push(vca);
    }
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
}
