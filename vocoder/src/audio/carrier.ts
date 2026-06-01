// ============================================================================
// carrier.ts -- the vocoder's CARRIER signal.
// ----------------------------------------------------------------------------
// The carrier is the harmonically-rich "raw material" that the vocoder will
// shape with the modulator's (mic's) formants in Phase 3. For Phase 2 we
// route it straight to the speakers so we can verify the synth + gesture
// control before adding any DSP on top.
//
// Voice composition (per the project spec):
//   - Sawtooth oscillator  (bright, lots of harmonics -> good vocoder bands)
//   - Square oscillator    (hollow, square-wave odd harmonics)
//   - White noise          (so unvoiced consonants like "s" and "t" survive
//                           the vocoder stage)
//
// Each component goes through its own gain so the mix is tweakable. The whole
// voice is gated by an envelope (gainEnv) which we attack/release via
// setGate(open).
//
// Polyphony note: Phase 2 only needs ONE pitch source (the right hand), so
// this file builds a single monophonic voice. In Phase 4 we'll wrap N voices
// into a PolyCarrier for chord support. The current shape keeps that easy.
// ============================================================================

export interface CarrierVoiceOptions {
  /** Mix levels for each oscillator/noise layer. */
  sawLevel?: number;
  squareLevel?: number;
  noiseLevel?: number;
  /** Pitch-glide time constant in seconds (for setTargetAtTime). */
  glideSec?: number;
  /** Attack/release time constants for the gate envelope. */
  attackSec?: number;
  releaseSec?: number;
}

const DEFAULT_OPTS: Required<CarrierVoiceOptions> = {
  sawLevel: 0.5,
  squareLevel: 0.3,
  noiseLevel: 0.12,
  glideSec: 0.03,
  attackSec: 0.005,
  releaseSec: 0.08,
};

export class CarrierVoice {
  readonly ctx: AudioContext;
  readonly output: GainNode;

  private readonly saw: OscillatorNode;
  private readonly sqr: OscillatorNode;
  private readonly noise: AudioBufferSourceNode;
  private readonly gainEnv: GainNode;
  private readonly opts: Required<CarrierVoiceOptions>;

  constructor(ctx: AudioContext, opts: CarrierVoiceOptions = {}) {
    this.ctx = ctx;
    this.opts = { ...DEFAULT_OPTS, ...opts };

    // --- Oscillators -----------------------------------------------------
    // Sawtooth + square give us a wide harmonic spectrum so the eventual
    // vocoder bands have content across the whole range.
    this.saw = ctx.createOscillator();
    this.saw.type = 'sawtooth';
    this.sqr = ctx.createOscillator();
    this.sqr.type = 'square';

    // --- Noise source ----------------------------------------------------
    // We synthesize a 2-second white-noise buffer once, then loop it. This
    // is the cheap-and-cheerful way to get continuous noise in Web Audio
    // (cheaper than running a worklet noise generator).
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.noise = ctx.createBufferSource();
    this.noise.buffer = noiseBuf;
    this.noise.loop = true;

    // --- Per-source gain (the "mix knobs") -------------------------------
    const sawGain = ctx.createGain();
    sawGain.gain.value = this.opts.sawLevel;
    const sqrGain = ctx.createGain();
    sqrGain.gain.value = this.opts.squareLevel;
    const noiseGain = ctx.createGain();
    noiseGain.gain.value = this.opts.noiseLevel;

    this.saw.connect(sawGain);
    this.sqr.connect(sqrGain);
    this.noise.connect(noiseGain);

    // --- Gate envelope ---------------------------------------------------
    // Start at zero. setGate() ramps to 1 (attack) or 0 (release) via
    // setTargetAtTime, which gives us nicely smooth clicks-free transitions.
    this.gainEnv = ctx.createGain();
    this.gainEnv.gain.value = 0;

    sawGain.connect(this.gainEnv);
    sqrGain.connect(this.gainEnv);
    noiseGain.connect(this.gainEnv);

    // --- Output node -----------------------------------------------------
    // Extra headroom gain so the carrier doesn't clip when summed with
    // other voices later.
    this.output = ctx.createGain();
    this.output.gain.value = 0.55;
    this.gainEnv.connect(this.output);

    // Start all sources. They run forever; the gate envelope handles silence.
    this.saw.start();
    this.sqr.start();
    this.noise.start();
  }

  /**
   * Set the voice's fundamental frequency. Both oscillators glide via
   * setTargetAtTime with the configured glideSec time constant, so the
   * pitch tracks gesture input smoothly without zippering.
   */
  setFrequency(hz: number): void {
    const now = this.ctx.currentTime;
    this.saw.frequency.setTargetAtTime(hz, now, this.opts.glideSec);
    // Run the square one octave below for a fatter bottom end -- this is a
    // taste choice; set to `hz` for tighter unison.
    this.sqr.frequency.setTargetAtTime(hz * 0.5, now, this.opts.glideSec);
  }

  /**
   * Open the gate (sound on) or close it (sound off). Uses asymmetric
   * attack/release times: fast attack so notes feel responsive, slightly
   * slower release so they don't sound choppy when pinching/unpinching.
   */
  setGate(open: boolean): void {
    const now = this.ctx.currentTime;
    const target = open ? 1 : 0;
    const tc = open ? this.opts.attackSec : this.opts.releaseSec;
    this.gainEnv.gain.setTargetAtTime(target, now, tc);
  }

  /**
   * Continuous voice level in [0, 1]. Used for crossfading harmonic
   * voices in/out (e.g. left-hand openness → density). Short fixed time
   * constant so the gain tracks the gesture without zipper noise, while
   * still being fast enough that the user perceives the openness change
   * immediately.
   */
  setLevel(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    this.gainEnv.gain.setTargetAtTime(clamped, this.ctx.currentTime, 0.02);
  }

  /** Stop all sources permanently. Voice is unusable after this. */
  dispose(): void {
    try { this.saw.stop(); } catch { /* already stopped */ }
    try { this.sqr.stop(); } catch { /* already stopped */ }
    try { this.noise.stop(); } catch { /* already stopped */ }
  }
}

// ============================================================================
// CarrierSynth -- polyphonic carrier (up to N voices).
//
// Phase 4 promoted this from monophonic to polyphonic so the left hand's
// finger count can select chord sizes (1 = mono root, 3 = triad, 5 = full
// pentad, etc.). The vocoder still sees ONE summed carrier signal because
// all voices share the same modulator (mic) for vocoding -- chord notes
// get vocoded together.
//
// setVoices(freqs) opens the first freqs.length voices and silences the
// rest. Per-voice gain attenuation prevents clipping as voice count grows.
// setFrequency() / setGate() are kept for backwards compatibility with the
// monophonic call sites (they delegate to a single-voice setVoices).
// ============================================================================

export interface CarrierSynthOptions {
  /** Maximum simultaneous voices. */
  maxVoices?: number;
  /**
   * Output trim. Master gate / FX chain live downstream, so leave headroom
   * here for the eventual sum across multiple voices.
   */
  outputGain?: number;
}

const SYNTH_DEFAULTS: Required<CarrierSynthOptions> = {
  maxVoices: 5,
  outputGain: 0.4,
};

export class CarrierSynth {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  readonly maxVoices: number;
  private readonly voices: CarrierVoice[];

  constructor(ctx: AudioContext, opts: CarrierSynthOptions = {}) {
    const merged = { ...SYNTH_DEFAULTS, ...opts };
    this.ctx = ctx;
    this.maxVoices = merged.maxVoices;

    this.output = ctx.createGain();
    // Per-voice attenuation so a full pentad doesn't clip relative to mono.
    // sqrt(N) keeps perceived loudness roughly constant.
    this.output.gain.value = merged.outputGain / Math.sqrt(merged.maxVoices);

    this.voices = [];
    for (let i = 0; i < merged.maxVoices; i++) {
      const v = new CarrierVoice(ctx);
      v.output.connect(this.output);
      // Voices start gated off; setVoices() opens the active ones.
      this.voices.push(v);
    }
  }

  /**
   * Activate the first `freqs.length` voices at the given frequencies
   * (gates them open) and silence the rest. The number of active voices
   * becomes the chord size.
   */
  setVoices(freqs: number[]): void {
    const n = Math.min(freqs.length, this.voices.length);
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      if (i < n) {
        v.setFrequency(freqs[i]!);
        v.setGate(true);
      } else {
        v.setGate(false);
      }
    }
  }

  /**
   * Set voice frequencies AND continuous per-voice levels. Like setVoices,
   * but instead of binary gate on/off, each voice's gain is a continuous
   * 0..1 value -- used by the auto-triad + density mapping to crossfade
   * the upper voices in/out with left-hand openness.
   *
   * Voice indices past `levels.length` are explicitly silenced.
   */
  setVoicesWithLevels(freqs: number[], levels: number[]): void {
    for (let i = 0; i < this.voices.length; i++) {
      const v = this.voices[i]!;
      if (i < freqs.length) {
        v.setFrequency(freqs[i]!);
        v.setLevel(levels[i] ?? 1);
      } else {
        v.setLevel(0);
      }
    }
  }

  /** Monophonic shorthand: open voice 0 at this frequency, mute the rest. */
  setFrequency(hz: number): void {
    this.setVoices([hz]);
  }

  /**
   * No-op since Phase 3 -- the master mute lives on the vocoder output.
   * Kept for compatibility with the older single-voice gate API.
   */
  setGate(_open: boolean): void {
    // intentionally empty
  }
}
