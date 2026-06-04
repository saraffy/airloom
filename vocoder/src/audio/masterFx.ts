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
//   vocodedIn    ──► wetGain ───┬─► preLimitSum ──► voxOutGain ─────────┐
//   dryCarrierIn ──► dryGain ───┤                                        │
//   voiceBlendIn ──► voiceBlendGain ──► preLimitSum                      │
//                                                                        ├─► limiter ──► output
//                wetGain ─┐                                               │
//                dryGain ─┴─► robotReverbTap ─┐                           │
//                                              ├─► reverbSendGain ─► ... ─► reverbReturnGain ──┘
//                            cleanVoxGain ────┘                              (parallel
//                                                                             into limiter)
//   cleanVoiceIn ──► cleanVoxGain ─────────────────────────────────────────┘
//
// Two SEND taps into the reverb:
//   - robotReverbTap  -- sums wetGain+dryGain (NOT voiceBlend, which stays
//                        dry by design), then scales by a mode-driven gain
//                        that mirrors voxOutGain. So robot signal only
//                        reaches the reverb when robot mode is active.
//   - cleanVoxGain    -- already mode-gated by the existing cleanVoxGain
//                        switch. Tap is POST that gain so clean signal
//                        only reaches the reverb when clean mode is active.
//
// The reverb RETURN goes directly to the master limiter, in parallel with
// the dry post-mode signals. This is what lets clean reverb survive in
// pinched mode -- previously the return was on preLimitSum, which got
// silenced by voxOutGain whenever you weren't in robot mode.
//
// voiceBlend is intentionally excluded from both reverb taps -- it joins
// preLimitSum directly, so it gets the same mode crossfade as the other
// dry signals but never reverberates.
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
  /**
   * Two convolver IRs are built at startup. Hand-distance crossfades
   * between them via setTailLength(0..1):
   *   0 = only the SHORT IR is sent to (tight, room-sized reverb)
   *   1 = only the LONG  IR is sent to (huge, lush hall)
   * Values between blend linearly so the tail GROWS continuously with
   * distance, not just gets louder.
   */
  reverbShortSec?: number;
  reverbLongSec?: number;
  /**
   * Reverb decay exponent. The envelope is (1 - t)^decay; LOWER = slower
   * decay (longer perceived tail relative to total length).
   *   1.0 = nearly linear, very long tail
   *   1.8 = lush, hall-like
   *   2.5 = small/medium room
   *   4+  = tight, plate-like
   */
  reverbDecay?: number;
  /** Reverb return gain (level of the wet reverb tail). */
  reverbReturnGain?: number;
  /** Master peak limiter threshold (dBFS). -1 = just below clipping. */
  limiterThresholdDb?: number;
  /**
   * Initial LFO rate for the tremolo stage (Hz). Tunable live via
   * setLfoRate. Typical musical tremolo: 4-7 Hz.
   */
  tremoloRateHz?: number;
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
  /**
   * ★ MAIN VOICE/ROBOT BALANCE KNOB ★
   * Gain on the natural-voice signal that's mixed INTO the robot path
   * alongside the vocoded carrier (active only in unpinched / robot mode;
   * pinched clean-voice mode and hand-absent silence are unaffected).
   *   0    = pure robot (no natural voice in the mix)
   *   0.35 = clearly audible voice on top of robot (default)
   *   1.0  = voice at full level alongside robot (will be louder than robot)
   * Tune in MAPPING.masterFx.voiceBlend. The master limiter at -1 dB will
   * catch peaks, so this won't clip even at 1.0 -- you'll just hear
   * limiter pumping.
   */
  voiceBlend?: number;
  /** Crossfade time constant (sec) for setMode transitions. */
  modeXfadeSec?: number;
}

const DEFAULTS: Required<MasterFXOptions> = {
  dryCarrierTrim: 0.3,
  initialWet: 1.0,
  reverbShortSec: 1.2,
  reverbLongSec: 3.5,
  reverbDecay: 1.8,
  reverbReturnGain: 0.85,
  limiterThresholdDb: -1,
  robotLevel: 1.0,
  cleanVoiceLevel: 1.2,
  voiceBlend: 0.35,
  modeXfadeSec: 0.015,
  tremoloRateHz: 5.5,
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
  /**
   * Connect the (preferably noise-gated) mic here. Mixed into the robot
   * path, so only audible when setMode('robot') is active. The dry voice
   * level inside the robot mix is controlled by `voiceBlend`.
   */
  readonly voiceBlendIn: GainNode;
  /** Final summed + limited output. Connect this to destination. */
  readonly output: GainNode;

  private readonly opts: Required<MasterFXOptions>;
  private readonly wetGain: GainNode;
  private readonly dryGain: GainNode;
  private readonly preLimitSum: GainNode;
  private readonly reverbSendGain: GainNode;
  private readonly reverbReturnGain: GainNode;
  /** Short IR -- "tight room". 100% active at tailLength=0. */
  private readonly convolverShort: ConvolverNode;
  /** Long IR -- "lush hall". 100% active at tailLength=1. */
  private readonly convolverLong: ConvolverNode;
  /** Per-convolver send gains; setTailLength crossfades these. */
  private readonly shortPathGain: GainNode;
  private readonly longPathGain: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  /** Master mute for the vocoded + dry-carrier sum (robot path's DRY signal). */
  private readonly voxOutGain: GainNode;
  /** Master mute for the clean-voice monitor path. */
  private readonly cleanVoxGain: GainNode;
  /** Voice-blend amount (mic into robot path); controlled by setVoiceBlend. */
  private readonly voiceBlendGain: GainNode;
  /**
   * Mode-driven gate on the ROBOT reverb send. Mirrors voxOutGain so the
   * robot signal only reaches the convolvers when in robot mode -- prevents
   * the robot tail from leaking into pinched (clean) mode.
   */
  private readonly robotReverbTap: GainNode;
  /**
   * Tremolo stage (after the master limiter, before output). Classic
   * asymmetric wiring:
   *    tremoloGain.gain.value = 1 - depth/2
   *    LFO -> tremoloDepthGain (gain = depth/2) -> tremoloGain.gain
   * so the signal gain oscillates between (1 - depth) and 1.
   * depth = 0 -> LFO contribution is 0, base value is 1 -> perfectly flat.
   */
  private readonly lfo: OscillatorNode;
  private readonly tremoloDepthGain: GainNode;
  private readonly tremoloGain: GainNode;
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
    this.voiceBlendIn = ctx.createGain();
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

    // --- Reverb: [robot tap + clean tap] -> [short || long] -> return ----
    // Two ConvolverNodes in parallel, each with its own exponential-decay
    // synthesized IR. shortPathGain and longPathGain crossfade between
    // them so the TAIL LENGTH grows with distance. ConvolverNode does
    // normalized FFT convolution -- cheap, plausible reverb without
    // shipping wavs.
    this.convolverShort = ctx.createConvolver();
    this.convolverShort.buffer = createReverbIR(
      ctx,
      this.opts.reverbShortSec,
      this.opts.reverbDecay,
    );
    this.convolverLong = ctx.createConvolver();
    this.convolverLong.buffer = createReverbIR(
      ctx,
      this.opts.reverbLongSec,
      this.opts.reverbDecay,
    );

    this.reverbSendGain = ctx.createGain();
    this.reverbSendGain.gain.value = 0; // setReverbSend ramps from here
    this.reverbReturnGain = ctx.createGain();
    this.reverbReturnGain.gain.value = this.opts.reverbReturnGain;

    // Mode-driven gate on the robot reverb send. Starts at 0 (silence
    // mode); setMode ramps it to robotLevel when robot mode engages and
    // back to 0 when leaving robot. Excludes voiceBlend (voiceBlend
    // connects to preLimitSum directly, NOT to robotReverbTap).
    this.robotReverbTap = ctx.createGain();
    this.robotReverbTap.gain.value = 0;
    this.wetGain.connect(this.robotReverbTap);
    this.dryGain.connect(this.robotReverbTap);
    this.robotReverbTap.connect(this.reverbSendGain);

    // Path-crossfade gains: setTailLength ramps shortPathGain = 1-t,
    // longPathGain = t. Linear crossfade -- at t=0.5 both are 0.5 so the
    // user hears a blended IR.
    this.shortPathGain = ctx.createGain();
    this.shortPathGain.gain.value = 1; // start at full short tail
    this.longPathGain = ctx.createGain();
    this.longPathGain.gain.value = 0;

    // Send -> per-path gain -> convolver -> common return.
    this.reverbSendGain.connect(this.shortPathGain).connect(this.convolverShort);
    this.reverbSendGain.connect(this.longPathGain).connect(this.convolverLong);
    this.convolverShort.connect(this.reverbReturnGain);
    this.convolverLong.connect(this.reverbReturnGain);
    // Reverb return goes DIRECTLY to the limiter (not preLimitSum). This
    // is what lets clean-mode reverb survive past voxOutGain's mute.
    // Per-path send gates (robotReverbTap, cleanVoxGain) already ensure
    // that only the currently-audible signal feeds the convolvers, so
    // the bypass of preLimitSum doesn't cause cross-mode leakage.

    // --- Voice-blend: mic INTO the robot mix ---------------------------
    // Lands on preLimitSum so it's subject to voxOutGain (only audible
    // when in robot mode; muted in cleanVoice/silence by the same
    // crossfade as the vocoded carrier).
    this.voiceBlendGain = ctx.createGain();
    this.voiceBlendGain.gain.value = this.opts.voiceBlend;
    this.voiceBlendIn.connect(this.voiceBlendGain).connect(this.preLimitSum);

    // --- Mode crossfade gains -------------------------------------------
    // The robot path (vocoded + dry carrier + reverb + voice blend) and
    // the clean voice monitor path are mutually exclusive. setMode() ramps
    // voxOutGain and cleanVoxGain in opposite directions to crossfade.
    this.voxOutGain = ctx.createGain();
    this.voxOutGain.gain.value = 0;
    this.preLimitSum.connect(this.voxOutGain);

    this.cleanVoxGain = ctx.createGain();
    this.cleanVoxGain.gain.value = 0;
    this.cleanVoiceIn.connect(this.cleanVoxGain);
    // Clean reverb tap: POST cleanVoxGain so the clean signal only
    // reaches the reverb when clean (pinched) mode is active.
    this.cleanVoxGain.connect(this.reverbSendGain);

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
    // Reverb wet return joins the limiter in parallel with the dry
    // post-mode signals -- the master limiter is the brickwall for the
    // summed (dry + reverb tail) signal.
    this.reverbReturnGain.connect(this.limiter);

    // --- Tremolo stage ---------------------------------------------------
    // Inserted between the master limiter and the final output GainNode so
    // it modulates the entire audible mix (robot, clean, reverb tail).
    // The recorder taps masterFx.output, so recordings include tremolo.
    this.lfo = ctx.createOscillator();
    this.lfo.type = 'sine';
    this.lfo.frequency.value = this.opts.tremoloRateHz;

    this.tremoloDepthGain = ctx.createGain();
    this.tremoloDepthGain.gain.value = 0; // depth = 0 initial -> no modulation

    this.tremoloGain = ctx.createGain();
    this.tremoloGain.gain.value = 1; // base level for depth = 0 (flat)

    // LFO modulates tremoloGain.gain at audio rate. AudioNode->AudioParam
    // connections ADD to the param's static value, so at depth=0 the
    // depth-gain is 0, LFO contribution is 0, and tremoloGain.gain stays
    // exactly at 1 -- perfectly flat as the spec requires.
    this.lfo.connect(this.tremoloDepthGain);
    this.tremoloDepthGain.connect(this.tremoloGain.gain);
    this.lfo.start();

    this.limiter.connect(this.tremoloGain).connect(this.output);
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

  /** Reverb send level (0..1). Routes the wet+dry mix into the convolvers. */
  setReverbSend(level: number): void {
    const l = Math.max(0, Math.min(1, level));
    this.reverbSendGain.gain.setTargetAtTime(l, this.ctx.currentTime, 0.05);
  }

  /**
   * Linear crossfade between the short and long IRs.
   *   0 = pure SHORT tail (tight room)
   *   1 = pure LONG  tail (lush hall)
   * Smooth-ramped so gestures don't introduce zipper.
   */
  setTailLength(t: number): void {
    const c = Math.max(0, Math.min(1, t));
    const now = this.ctx.currentTime;
    const tc = 0.05;
    this.shortPathGain.gain.setTargetAtTime(1 - c, now, tc);
    this.longPathGain.gain.setTargetAtTime(c, now, tc);
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
    let robotReverbTarget = 0;
    switch (mode) {
      case 'robot':
        voxTarget = this.opts.robotLevel;
        // robotReverbTap mirrors voxOutGain so the robot reverb send is
        // gated by mode the same way the dry signal is.
        robotReverbTarget = this.opts.robotLevel;
        break;
      case 'cleanVoice':
        cleanTarget = this.opts.cleanVoiceLevel;
        break;
      case 'silence':
        break;
    }
    this.voxOutGain.gain.setTargetAtTime(voxTarget, t, tc);
    this.cleanVoxGain.gain.setTargetAtTime(cleanTarget, t, tc);
    this.robotReverbTap.gain.setTargetAtTime(robotReverbTarget, t, tc);
  }

  /**
   * Live-tune the voice/robot balance (0..1). Smooth-ramped so it can be
   * driven by automation without clicks. Default comes from
   * MAPPING.masterFx.voiceBlend.
   */
  setVoiceBlend(level: number): void {
    const l = Math.max(0, Math.min(1, level));
    this.voiceBlendGain.gain.setTargetAtTime(l, this.ctx.currentTime, 0.02);
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

  get voiceBlendValue(): number {
    return this.voiceBlendGain.gain.value;
  }

  /** Current short/long IR crossfade position (0 = short, 1 = long). */
  get tailLength(): number {
    return this.longPathGain.gain.value;
  }

  /**
   * Set tremolo depth in [0, 1]. Smooth-ramped (20ms TC) so depth changes
   * never click. depth=0 cleanly converges to "perfectly flat" because the
   * depth-gain ramps to 0 and the LFO contribution to tremoloGain.gain
   * vanishes.
   */
  setTremoloDepth(depth: number): void {
    const d = Math.max(0, Math.min(1, depth));
    const t = this.ctx.currentTime;
    const tc = 0.02;
    // Base value: dips downward as depth grows, top of swing stays at 1.
    this.tremoloGain.gain.setTargetAtTime(1 - d / 2, t, tc);
    // LFO swing amplitude: peak-to-peak = depth, so depth/2 each direction.
    this.tremoloDepthGain.gain.setTargetAtTime(d / 2, t, tc);
  }

  /** Set the LFO rate (Hz). Smooth-ramped to avoid frequency clicks. */
  setLfoRate(rateHz: number): void {
    const r = Math.max(0.1, rateHz);
    this.lfo.frequency.setTargetAtTime(r, this.ctx.currentTime, 0.05);
  }

  /** Current effective tremolo depth in [0, 1] (reverse of setTremoloDepth). */
  get tremoloDepthValue(): number {
    return Math.max(0, Math.min(1, (1 - this.tremoloGain.gain.value) * 2));
  }

  /** Current LFO rate in Hz. */
  get lfoRateHz(): number {
    return this.lfo.frequency.value;
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
