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

  /** Stop all sources permanently. Voice is unusable after this. */
  dispose(): void {
    try { this.saw.stop(); } catch { /* already stopped */ }
    try { this.sqr.stop(); } catch { /* already stopped */ }
    try { this.noise.stop(); } catch { /* already stopped */ }
  }
}

// ============================================================================
// CarrierSynth -- thin wrapper around (currently) one voice.
//
// Why bother with a wrapper at all? Because Phase 4 will turn this into a
// proper polyphonic synth (multiple voices for chords), and the rest of the
// app should stay oblivious. Today its API is just setFrequency / setGate.
// ============================================================================

export class CarrierSynth {
  readonly ctx: AudioContext;
  readonly output: GainNode;
  private readonly voice: CarrierVoice;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    this.voice = new CarrierVoice(ctx);

    // Master output trim. Keep some headroom for the Phase-5 FX chain.
    this.output = ctx.createGain();
    this.output.gain.value = 0.4;
    this.voice.output.connect(this.output);
  }

  setFrequency(hz: number): void {
    this.voice.setFrequency(hz);
  }

  setGate(open: boolean): void {
    this.voice.setGate(open);
  }
}
