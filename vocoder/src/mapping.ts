// ============================================================================
// mapping.ts -- gesture-to-parameter mapping and audio-engine configuration.
// ----------------------------------------------------------------------------
// This is the ONE place to tweak how hand gestures drive the audio engine,
// AND the place to tune the vocoder itself (band count, Q, env times,
// dry-mix, output gain). Every value here is meant to be hand-tunable; the
// rest of the app reads these constants instead of hard-coding numbers.
//
// Phase 3 uses `pitch`, `gate`, `scale`, and `vocoder` sections. Phase 4
// will add chord selection, wet/dry, and reverb amount.
// ============================================================================

import { SCALES, type ScaleName } from './audio/scales';
import type { VocoderOptions } from './audio/vocoder';
import type { NoiseGateOptions } from './audio/noiseGate';
import type { MasterFXOptions } from './audio/masterFx';
import type { OneEuroFilterOptions } from './smoothing';

export interface Mapping {
  pitch: {
    /** MIDI note when right hand is at the BOTTOM of the frame (wristY = 1). */
    midiLow: number;
    /** MIDI note when right hand is at the TOP of the frame (wristY = 0). */
    midiHigh: number;
    /**
     * Dead-zone margins (in normalized y) to ignore at the very edges of
     * the frame, where MediaPipe is less stable. 0.05 = 5% top + 5% bottom.
     */
    yDeadZone: number;
    /**
     * Hysteresis margin (in semitones) for the scale snap. Prevents notes
     * from flip-flopping when the hand is steady near a scale boundary.
     * 0.0  = no hysteresis (memoryless snap, jittery)
     * 0.3  = small dead band, snappy melodic playing
     * 0.7  = sticky note holds, harder to do fast scalar runs
     */
    snapHysteresisSemitones: number;
  };
  gate: {
    /** Pinch ratio at/above which the gate opens (sound on). */
    pinchOpen: number;
    /** Pinch ratio at/below which the gate closes (sound off). */
    pinchClose: number;
    /**
     * How long (ms) to hold the audio gate open after the right hand
     * disappears from the *stabilized* tracking stream. Decouples audio
     * from tracker jitter -- 1-5 frame dropouts ride straight through.
     * Stacks on top of handStickyFrames, so the total bridge is roughly
     *   handStickyFrames * frameMs + trackingHoldMs.
     */
    trackingHoldMs: number;
  };
  scale: {
    /** Pitch class root of the key. 0=C, 2=D, 4=E, 5=F, 7=G, 9=A, 11=B. */
    root: number;
    /** Scale name; see audio/scales.ts for the full list. */
    name: ScaleName;
  };
  /**
   * Pass-through options to Vocoder.create(). All knobs here are
   * documented in audio/vocoder.ts -- see VocoderOptions.
   */
  vocoder: VocoderOptions;
  /**
   * Pass-through options to NoiseGate.create(). Documented in
   * audio/noiseGate.ts. The gate sits in front of the vocoder modulator
   * input so background noise never drives the bands.
   */
  noiseGate: NoiseGateOptions;
  /**
   * How many consecutive frames to keep a hand visible after MediaPipe
   * stops reporting it. Bridges brief tracker dropouts without making a
   * truly-gone hand stick around.
   *  0 = no stickiness, ~3 = ~100ms at 30fps, ~6 = ~200ms.
   */
  handStickyFrames: number;
  /**
   * Chord stacking from the left hand's extended-finger count.
   *   1 finger  -> 1 voice  (mono root)
   *   2..N      -> N voices stacked in "thirds" (every other scale degree)
   * fingerOpenRatio / fingerCloseRatio give per-finger hysteresis so the
   * count doesn't chatter at extension boundaries.
   */
  chord: {
    /** Max simultaneous voices. */
    maxVoices: number;
    /** Per-finger ratio above which a finger flips to "extended". */
    fingerOpenRatio: number;
    /** Per-finger ratio below which an extended finger flips to "curled". */
    fingerCloseRatio: number;
    /** Same pair for the thumb (geometrically different from other fingers). */
    thumbOpenRatio: number;
    thumbCloseRatio: number;
  };
  /**
   * Left-hand openness -> wet/dry mix. Linear map: openness in
   * [opennessMin, opennessMax] linearly maps to wet in [wetMin, wetMax].
   * wet = 1 -> full vocoded; wet = 0 -> full dry carrier.
   */
  wetDry: {
    opennessMin: number;
    opennessMax: number;
    wetMin: number;
    wetMax: number;
  };
  /**
   * Two-hand horizontal distance -> reverb send level. Distance is the
   * absolute difference in wrist x (0..1 frame-relative).
   */
  reverbSend: {
    distanceMin: number;
    distanceMax: number;
    sendMin: number;
    sendMax: number;
  };
  /** Pass-through options to MasterFX. */
  masterFx: MasterFXOptions;
  /**
   * One-euro filter parameters applied to every continuous gesture value
   * (right wristY, left openness, two-hand distance). See smoothing.ts.
   */
  smoothing: OneEuroFilterOptions;
}

export const MAPPING: Mapping = {
  pitch: {
    midiLow: 48,                  // C3 ~ 130.8 Hz
    midiHigh: 84,                 // C6 ~ 1046.5 Hz
    yDeadZone: 0.05,
    snapHysteresisSemitones: 0.3, // ~½ note worth of dead band each way
  },
  gate: {
    // Hysteresis band so the gate doesn't chatter near the threshold.
    pinchOpen: 0.55,
    pinchClose: 0.40,
    // 300ms hangover -- brief tracker dropouts shouldn't chop the audio.
    trackingHoldMs: 300,
  },
  scale: {
    root: 0,                      // C
    name: 'pentatonicMinor',
  },
  vocoder: {
    bands: 24,                    // 16→24 for better vowel resolution
    lowHz: 80,
    highHz: 8000,
    q: 5,                         // soft rasp; extra bands keep vowels clear
    attackSec: 0.005,             // ~5ms: punchy consonants
    releaseSec: 0.020,            // 20ms: trades a touch of vowel snap for warble-free holds
    dryMix: 0.0,                  // raw mic into vocoded output. 0 = pure robot;
                                  // raise (e.g. 0.05) ONLY if you want some
                                  // natural voice character. Was 0.12 -> bled
                                  // into the unpinched signal and made it
                                  // sound voice-like rather than robotic.
    outputGain: 7.0,              // 5→7: more drive into the compressor for loudness
    makeupGain: 1.6,              // 1.3→1.6: pair with outputGain for the robot punch
  },
  noiseGate: {
    // Open/close hysteresis so inter-syllable dips don't chop speech.
    openDb: -45,                  // crossing above opens the gate immediately
    closeDb: -60,                 // looser close: sustained singing dips don't trigger
    holdSec: 0.4,                 // longer hold: easily bridges normal syllable pauses
    attackSec: 0.005,
    releaseSec: 0.08,
    envSmoothSec: 0.020,
  },
  handStickyFrames: 8,            // ~270ms bridge for tracker dropouts at 30fps
  chord: {
    maxVoices: 5,                 // 1=mono, 5=open pentad
    // Per-finger ratios -- empirical, calibrated against typical hand poses.
    fingerOpenRatio: 0.85,        // tip > 85% palm-length from MCP -> extended
    fingerCloseRatio: 0.65,
    thumbOpenRatio: 0.55,         // thumb's geometry is different
    thumbCloseRatio: 0.40,
  },
  wetDry: {
    // Openness range covers fist (≈ 1.0) through fully-spread palm (≈ 3.0).
    // Mapping is INVERTED: fist = full wet (vocoded), open = drier carrier.
    opennessMin: 1.0,
    opennessMax: 3.0,
    wetMin: 0.35,                 // open palm: a bit of dry carrier comes through
    wetMax: 1.0,                  // fist: full vocoded
  },
  reverbSend: {
    // Horizontal hand distance: hands together ≈ 0.05, arms wide ≈ 0.7.
    distanceMin: 0.10,
    distanceMax: 0.70,
    sendMin: 0,
    sendMax: 0.7,
  },
  masterFx: {
    dryCarrierTrim: 0.3,
    initialWet: 1.0,
    reverbDurationSec: 1.6,       // small-medium room tail
    reverbDecay: 2.5,
    reverbReturnGain: 0.55,
    limiterThresholdDb: -1,
    robotLevel: 1.0,              // master gain for the robot path when active
    cleanVoiceLevel: 1.2,         // master gain for the clean monitor when pinched

    // ★★★ MAIN VOICE/ROBOT BALANCE KNOB ★★★
    // Mix natural voice INTO the robot path. ROBOT MODE ONLY -- pinched
    // clean-voice and hand-absent silence are unaffected.
    //   0    = pure robot
    //   0.35 = clearly audible natural voice on top of robot
    //   0.5  = close to 50/50, voice well-balanced with robot
    //   0.7  = voice slightly dominant over robot (current)
    //   1.0  = voice at full mic level alongside robot (louder than robot)
    voiceBlend: 0.7,

    modeXfadeSec: 0.015,          // smooth crossfade between robot/clean/silence
  },
  smoothing: {
    // Hand tracking runs at 30 fps with notable per-frame jitter.
    // minCutoff 1.0Hz removes that jitter at rest; beta 0.1 opens the
    // cutoff during deliberate motion so there's minimal lag.
    minCutoff: 1.0,
    beta: 0.1,
    dCutoff: 1.0,
  },
};

export interface ResolvedChord {
  voices: number[];     // MIDI notes
  fingerCount: number;  // count from left-hand extension hysteresis (0..maxVoices)
}

/** Convenience accessor for the current scale's semitone offsets. */
export function currentScale(): readonly number[] {
  return SCALES[MAPPING.scale.name];
}
