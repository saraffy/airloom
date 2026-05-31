// ============================================================================
// mapping.ts -- gesture-to-parameter mapping configuration.
// ----------------------------------------------------------------------------
// This is the ONE place to tweak how hand gestures drive the audio engine.
// Every value here is meant to be hand-tunable; the rest of the app reads
// these constants instead of hard-coding numbers.
//
// Phase 2 only uses the `pitch`, `gate`, and `scale` sections. Phase 4 will
// expand the file to cover chord selection, wet/dry, and reverb amount.
// ============================================================================

import { SCALES, type ScaleName } from './audio/scales';

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
  };
  gate: {
    /** Pinch ratio at/above which the gate opens (sound on). */
    pinchOpen: number;
    /** Pinch ratio at/below which the gate closes (sound off). */
    pinchClose: number;
  };
  scale: {
    /** Pitch class root of the key. 0=C, 2=D, 4=E, 5=F, 7=G, 9=A, 11=B. */
    root: number;
    /** Scale name; see audio/scales.ts for the full list. */
    name: ScaleName;
  };
}

export const MAPPING: Mapping = {
  pitch: {
    midiLow: 48,   // C3 ~ 130.8 Hz
    midiHigh: 84,  // C6 ~ 1046.5 Hz  (3-octave theremin range)
    yDeadZone: 0.05,
  },
  gate: {
    // The two thresholds form a hysteresis band so the gate doesn't chatter
    // when the user holds their fingers near the boundary.
    pinchOpen: 0.55,
    pinchClose: 0.40,
  },
  scale: {
    root: 0,                  // C
    name: 'pentatonicMinor',  // forgiving default -- every note "works"
  },
};

/** Convenience accessor for the current scale's semitone offsets. */
export function currentScale(): readonly number[] {
  return SCALES[MAPPING.scale.name];
}
