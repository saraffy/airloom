// ============================================================================
// masterFx.ts -- master output chain (Phase 4 stub, completed in Phase 5).
// ----------------------------------------------------------------------------
// Sits between the vocoder and the destination. Its job is the wet/dry
// crossfade between the VOCODED signal and the DRY CARRIER, plus a reverb
// send/return that Phase 5 will populate.
//
// Topology today:
//
//   vocoder.output ──> vocodedIn ──> wetGain ─┐
//                                              ├─> output ──> destination
//   carrier.output ──> dryCarrierIn ──> dryGain ─┘
//                                              ↑
//                                              │  reverbSendGain (Phase 5
//                                              │  will tap pre-output here
//                                              │  to feed a ConvolverNode and
//                                              │  sum the wet return back in)
//
// The wet/dry sum is linear (not equal-power) for simplicity. A `dryCarrierTrim`
// factor scales the carrier's contribution because its un-vocoded level
// (saw + square + noise stack across N voices) is much hotter than the
// post-compressor vocoded signal -- without trim, a 50/50 mix would be
// drowned by the carrier.
// ============================================================================

export interface MasterFXOptions {
  /**
   * Multiplier applied to the dry-carrier path to balance it against the
   * compressed vocoded signal. ~0.3 = roughly equal loudness at 50/50 mix.
   */
  dryCarrierTrim?: number;
  /** Initial wet level in [0,1] (1 = full vocoded, 0 = full dry carrier). */
  initialWet?: number;
}

const DEFAULTS: Required<MasterFXOptions> = {
  dryCarrierTrim: 0.3,
  initialWet: 1.0,
};

export class MasterFX {
  readonly ctx: AudioContext;
  /** Connect the vocoded signal (vocoder.output) here. */
  readonly vocodedIn: GainNode;
  /** Connect the dry carrier signal here (parallel tap from CarrierSynth). */
  readonly dryCarrierIn: GainNode;
  /** Final summed output. Connect this to destination. */
  readonly output: GainNode;

  private readonly opts: Required<MasterFXOptions>;
  private readonly wetGain: GainNode;
  private readonly dryGain: GainNode;
  /** Phase 5 reverb send level. Currently routes nowhere; just stored. */
  private readonly reverbSendGain: GainNode;
  private currentWet: number;

  constructor(ctx: AudioContext, opts: MasterFXOptions = {}) {
    this.ctx = ctx;
    this.opts = { ...DEFAULTS, ...opts };
    this.currentWet = this.opts.initialWet;

    this.vocodedIn = ctx.createGain();
    this.vocodedIn.gain.value = 1;
    this.dryCarrierIn = ctx.createGain();
    this.dryCarrierIn.gain.value = 1;
    this.output = ctx.createGain();
    this.output.gain.value = 1;

    this.wetGain = ctx.createGain();
    this.wetGain.gain.value = this.opts.initialWet;
    this.dryGain = ctx.createGain();
    this.dryGain.gain.value = (1 - this.opts.initialWet) * this.opts.dryCarrierTrim;

    this.vocodedIn.connect(this.wetGain).connect(this.output);
    this.dryCarrierIn.connect(this.dryGain).connect(this.output);

    // Phase 5 placeholder. The reverb send sits in the audio graph but
    // doesn't route anywhere yet. When Phase 5 wires a ConvolverNode, the
    // chain becomes:
    //   vocodedIn -> reverbSendGain -> ConvolverNode -> reverbReturnGain -> output
    this.reverbSendGain = ctx.createGain();
    this.reverbSendGain.gain.value = 0;
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

  /** Reverb send level (0..1). Phase 5 will route this to a ConvolverNode. */
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
}
