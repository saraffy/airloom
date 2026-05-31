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
    dryMix: 0.12,                 // ~12% raw voice mixed in for naturalness (now gated)
    outputGain: 5.0,              // drives the compressor harder for more perceived loudness
    makeupGain: 1.3,              // post-compressor boost; pair with outputGain to taste
  },
  noiseGate: {
    thresholdDb: -48,             // -45 was clipping soft speech; loosened slightly
    attackSec: 0.005,
    releaseSec: 0.1,
    envSmoothSec: 0.020,
  },
  handStickyFrames: 8,            // ~270ms bridge for tracker dropouts at 30fps
};

/** Convenience accessor for the current scale's semitone offsets. */
export function currentScale(): readonly number[] {
  return SCALES[MAPPING.scale.name];
}
