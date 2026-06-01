// ============================================================================
// masterFx.ts -- master output chain (complete after Phase 5).
// ----------------------------------------------------------------------------
// Sits between the vocoder and the destination. Responsibilities:
//
//   - Wet/dry crossfade between the VOCODED signal and the DRY CARRIER
//     (driven by left-hand openness via main.ts).
//   - Convolver reverb with a synthesized exponential-decay noise IR
//     (driven by two-hand distance).
//   - Final brickwall limiter on the SUMMED output. The vocoder's internal
//     limiter only catches the vocoded path; this one catches dry carrier
//     and reverb-tail peaks too.
//
// Topology:
//
//   vocodedIn   ──► wetGain ───┐
//                              ├──► preLimitSum ──► limiter ──► output
//   dryCarrierIn ──► dryGain ──┤
//                              │
//   wetGain ──► reverbSend ──► Convolver ──► reverbReturn ──► preLimitSum
//   dryGain ──► reverbSend ───┘                                ▲
//                                                              │
//                                                            (sum)
//
// Reverb send taps the PRE-mix signals (wetGain + dryGain outputs) so the
// reverb hears whatever the user's current mix is, but the dry/wet
// FADE STILL APPLIES TO THE DRY PATH ONLY -- reverb tail is unaffected
// by openness. This keeps the reverb feel consistent as you blend.
// ============================================================================

export interface MasterFXOptions {
  /**
   * Multiplier applied to the dry-carrier path to balance it against the
   * compressed vocoded signal. ~0.3 = roughly equal loudness at 50/50 mix.
   */
  dryCarrierTrim?: number;
  /** Initial wet level in [0,1] (1 = full vocoded, 0 = full dry carrier). */
  initialWet?: number;
  /** Reverb impulse-response duration in seconds. */
  reverbDurationSec?: number;
  /**
   * Reverb decay exponent. The envelope is (1 - t)^decay; higher = faster
   * decay (drier feel). 1 = linear, 2.5 = small/medium room, 4+ = tight.
   */
  reverbDecay?: number;
  /** Reverb return gain (level of the wet reverb tail). */
  reverbReturnGain?: number;
  /** Master peak limiter threshold (dBFS). -1 = just below clipping. */
  limiterThresholdDb?: number;
}

const DEFAULTS: Required<MasterFXOptions> = {
  dryCarrierTrim: 0.3,
  initialWet: 1.0,
  reverbDurationSec: 1.6,
  reverbDecay: 2.5,
  reverbReturnGain: 0.55,
  limiterThresholdDb: -1,
};

export class MasterFX {
  readonly ctx: AudioContext;
  /** Connect the vocoded signal (vocoder.output) here. */
  readonly vocodedIn: GainNode;
  /** Connect the dry carrier signal here (parallel tap from CarrierSynth). */
  readonly dryCarrierIn: GainNode;
  /** Final summed + limited output. Connect this to destination. */
  readonly output: GainNode;

  private readonly opts: Required<MasterFXOptions>;
  private readonly wetGain: GainNode;
  private readonly dryGain: GainNode;
  private readonly preLimitSum: GainNode;
  private readonly reverbSendGain: GainNode;
  private readonly reverbReturnGain: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly limiter: DynamicsCompressorNode;
  private currentWet: number;

  constructor(ctx: AudioContext, opts: MasterFXOptions = {}) {
    this.ctx = ctx;
    this.opts = { ...DEFAULTS, ...opts };
    this.currentWet = this.opts.initialWet;

    // --- Input/output hubs ----------------------------------------------
    this.vocodedIn = ctx.createGain();
    this.dryCarrierIn = ctx.createGain();
    this.output = ctx.createGain();

    // --- Wet/dry pair (left-hand openness drives setWetDry) -------------
    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = this.opts.initialWet;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = (1 - this.opts.initialWet) * this.opts.dryCarrierTrim;

    // --- Sum bus ---------------------------------------------------------
    this.preLimitSum = ctx.createGain();
    this.preLimitSum.gain.value = 1;

    this.vocodedIn.connect(this.wetGain).connect(this.preLimitSum);
    this.dryCarrierIn.connect(this.dryGain).connect(this.preLimitSum);

    // --- Reverb: send -> convolver -> return -----------------------------
    // ConvolverNode does normalized FFT convolution. Synthesized IR is
    // stereo exponential-decay white noise -- cheap, plausible-sounding
    // small-room reverb without shipping a wav file.
    this.convolver = ctx.createConvolver();
    this.convolver.buffer = createReverbIR(
      ctx,
      this.opts.reverbDurationSec,
      this.opts.reverbDecay,
    );

    this.reverbSendGain = ctx.createGain();
    this.reverbSendGain.gain.value = 0; // setReverbSend ramps from here
    this.reverbReturnGain = ctx.createGain();
    this.reverbReturnGain.gain.value = this.opts.reverbReturnGain;

    // Tap the wet AND dry gains for the reverb send. No feedback risk:
    // the only signal in is wetGain/dryGain (post-mix), the only signal
    // out is reverbReturn -> preLimitSum.
    this.wetGain.connect(this.reverbSendGain);
    this.dryGain.connect(this.reverbSendGain);
    this.reverbSendGain.connect(this.convolver);
    this.convolver.connect(this.reverbReturnGain).connect(this.preLimitSum);

    // --- Master brickwall limiter ---------------------------------------
    // Catches summed peaks across vocoded + dry + reverb tail. The
    // vocoder's internal limiter only sees its own output, so this is
    // the *only* limiter the dry-carrier path passes through.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = this.opts.limiterThresholdDb;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;
    this.preLimitSum.connect(this.limiter).connect(this.output);
  }

  /**
   * Set wet (vocoded) level. Dry carrier gets (1 - wet) * dryCarrierTrim
   * for loudness matching. Smooth-ramped to avoid clicks.
   */
  setWetDry(wet: number): void {
    const w = Math.max(0, Math.min(1, wet));
    this.currentWet = w;
    const d = (1 - w) * this.opts.dryCarrierTrim;
    const t = this.ctx.currentTime;
    this.wetGain.gain.setTargetAtTime(w, t, 0.02);
    this.dryGain.gain.setTargetAtTime(d, t, 0.02);
  }

  /** Reverb send level (0..1). Now actually routes to the convolver. */
  setReverbSend(level: number): void {
    const l = Math.max(0, Math.min(1, level));
    this.reverbSendGain.gain.setTargetAtTime(l, this.ctx.currentTime, 0.05);
  }

  get wetLevel(): number {
    return this.currentWet;
  }

  get reverbSendLevel(): number {
    return this.reverbSendGain.gain.value;
  }

  /** Current limiter gain reduction in dB (positive number = reduction amount). */
  get limiterReductionDb(): number {
    return -this.limiter.reduction;
  }
}

/**
 * Synthesize a stereo exponential-decay white-noise impulse response.
 *
 * Envelope: env(t) = (1 - t)^decay, where t in [0,1] over the buffer length.
 * Channels use independent random noise so the reverb tail is decorrelated
 * (gives a wide, immersive sound on stereo systems / headphones).
 */
function createReverbIR(
  ctx: AudioContext,
  durationSec: number,
  decay: number,
): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      const t = i / length;
      const env = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * env;
    }
  }
  return buffer;
}
