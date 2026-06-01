// ============================================================================
// masterFx.ts -- master output chain.
// ----------------------------------------------------------------------------
// Sits between the vocoder and the destination. Responsibilities:
//
//   - Wet/dry crossfade between the VOCODED signal and the DRY CARRIER
//     (driven by left-hand openness via main.ts).
//   - Convolver reverb with a synthesized exponential-decay noise IR
//     (driven by two-hand distance).
//   - Mode crossfade between the robot path (vocoder + dry carrier +
//     reverb) and a CLEAN VOICE monitor path (raw mic). Pinch toggles
//     between modes; setMode() does a smooth ~15ms exponential
//     crossfade so there are no clicks.
//   - Final brickwall limiter on the SUMMED output. The vocoder's internal
//     limiter only catches the vocoded path; this one also protects the
//     dry carrier, reverb tail, AND clean voice paths.
//
// Topology:
//
//   vocodedIn    ──► wetGain ───┐
//                               ├──► preLimitSum ──► voxOutGain ──┐
//   dryCarrierIn ──► dryGain ───┤                                  │
//                                                                  ├──► limiter ──► output
//                                                                  │
//   cleanVoiceIn ──► cleanVoxGain ─────────────────────────────────┘
//
//   wetGain/dryGain ──► reverbSend ──► Convolver ──► reverbReturn ──► preLimitSum
//
// The wet/dry crossfade applies to the DRY CARRIER blend only. The clean
// voice path is its own thing -- it doesn't go through wet/dry or reverb,
// and voxOutGain/cleanVoxGain are mutually exclusive (driven by setMode).
// ============================================================================

export type MasterMode = 'robot' | 'cleanVoice' | 'silence';

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
  /**
   * Robot-path gain when setMode('robot') is active. 1.0 is unity -- the
   * vocoder's own outputGain/makeupGain do most of the level-setting.
   */
  robotLevel?: number;
  /**
   * Clean-voice-path gain when setMode('cleanVoice') is active. Mic is
   * unprocessed so a small boost is usually appropriate to match the
   * perceived loudness of the vocoded robot path.
   */
  cleanVoiceLevel?: number;
  /** Crossfade time constant (sec) for setMode transitions. */
  modeXfadeSec?: number;
}

const DEFAULTS: Required<MasterFXOptions> = {
  dryCarrierTrim: 0.3,
  initialWet: 1.0,
  reverbDurationSec: 1.6,
  reverbDecay: 2.5,
  reverbReturnGain: 0.55,
  limiterThresholdDb: -1,
  robotLevel: 1.0,
  cleanVoiceLevel: 1.2,
  modeXfadeSec: 0.015,
};

export class MasterFX {
  readonly ctx: AudioContext;
  /** Connect the vocoded signal (vocoder.output) here. */
  readonly vocodedIn: GainNode;
  /** Connect the dry carrier signal here (parallel tap from CarrierSynth). */
  readonly dryCarrierIn: GainNode;
  /**
   * Connect the raw mic here. Routed to the clean-voice monitor path,
   * which is only audible when setMode('cleanVoice') is active.
   */
  readonly cleanVoiceIn: GainNode;
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
  /** Master mute for the entire vocoded/dry-carrier/reverb mix. */
  private readonly voxOutGain: GainNode;
  /** Master mute for the clean-voice monitor path. */
  private readonly cleanVoxGain: GainNode;
  private currentWet: number;
  private currentMode: MasterMode = 'silence';

  constructor(ctx: AudioContext, opts: MasterFXOptions = {}) {
    this.ctx = ctx;
    this.opts = { ...DEFAULTS, ...opts };
    this.currentWet = this.opts.initialWet;

    // --- Input/output hubs ----------------------------------------------
    this.vocodedIn = ctx.createGain();
    this.dryCarrierIn = ctx.createGain();
    this.cleanVoiceIn = ctx.createGain();
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

    // --- Mode crossfade gains -------------------------------------------
    // The robot path (vocoded + dry carrier + reverb) and the clean voice
    // path are mutually exclusive. setMode() ramps voxOutGain and
    // cleanVoxGain in opposite directions to crossfade.
    this.voxOutGain = ctx.createGain();
    this.voxOutGain.gain.value = 0;
    this.preLimitSum.connect(this.voxOutGain);

    this.cleanVoxGain = ctx.createGain();
    this.cleanVoxGain.gain.value = 0;
    this.cleanVoiceIn.connect(this.cleanVoxGain);

    // --- Master brickwall limiter ---------------------------------------
    // Catches summed peaks across vocoded + dry + reverb tail AND the
    // clean monitor path. -1 dBFS, hard knee, 20:1.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = this.opts.limiterThresholdDb;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.001;
    this.limiter.release.value = 0.05;
    this.voxOutGain.connect(this.limiter);
    this.cleanVoxGain.connect(this.limiter);
    this.limiter.connect(this.output);
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

  /**
   * Switch between the three master modes. Crossfade is exponential
   * (setTargetAtTime) so it's smooth/click-free at any speed.
   *   - 'robot'     : voxOutGain -> robotLevel; cleanVoxGain -> 0
   *   - 'cleanVoice': voxOutGain -> 0;          cleanVoxGain -> cleanVoiceLevel
   *   - 'silence'   : both -> 0
   */
  setMode(mode: MasterMode): void {
    this.currentMode = mode;
    const t = this.ctx.currentTime;
    const tc = this.opts.modeXfadeSec;
    let voxTarget = 0;
    let cleanTarget = 0;
    switch (mode) {
      case 'robot':
        voxTarget = this.opts.robotLevel;
        break;
      case 'cleanVoice':
        cleanTarget = this.opts.cleanVoiceLevel;
        break;
      case 'silence':
        break;
    }
    this.voxOutGain.gain.setTargetAtTime(voxTarget, t, tc);
    this.cleanVoxGain.gain.setTargetAtTime(cleanTarget, t, tc);
  }

  get mode(): MasterMode {
    return this.currentMode;
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
