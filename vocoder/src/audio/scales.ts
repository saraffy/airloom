// ============================================================================
// scales.ts -- pitch quantization helpers.
// ----------------------------------------------------------------------------
// We map a continuous gesture value (e.g. right-hand y) to a continuous MIDI
// note, then SNAP that note to the nearest pitch in the active scale. This
// gives a "theremin with training wheels" feel: smooth glides, but every
// landing note belongs to the chosen key.
// ============================================================================

export type ScaleName =
  | 'chromatic'
  | 'major'
  | 'minor'
  | 'pentatonicMajor'
  | 'pentatonicMinor'
  | 'dorian'
  | 'mixolydian';

/**
 * Scale degrees as semitone offsets from the root (0..11). The quantizer
 * snaps a MIDI note's pitch-class component to the nearest degree.
 */
export const SCALES: Record<ScaleName, readonly number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonicMajor: [0, 2, 4, 7, 9],
  pentatonicMinor: [0, 3, 5, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

/** Pitch class index for note names. C=0, C#=1, ..., B=11. */
export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/**
 * Convert a MIDI note number to frequency in Hz.
 * MIDI 69 = A4 = 440 Hz; each +1 = +1 semitone.
 */
export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Quantize a continuous MIDI value to the nearest note in the given scale.
 *
 * @param midi   Continuous MIDI note (e.g. 67.4). Can be fractional.
 * @param root   Pitch-class root of the key (0..11). C=0, D=2, etc.
 * @param scale  Semitone offsets within an octave (e.g. SCALES.major).
 * @returns      Integer MIDI note belonging to the scale.
 */
export function quantizeToScale(
  midi: number,
  root: number,
  scale: readonly number[],
): number {
  // Work in offsets relative to root so we can compare pitch classes.
  const relative = midi - root;
  const octave = Math.floor(relative / 12);
  const pc = ((relative % 12) + 12) % 12; // 0..11.999..

  // Find the scale degree (in either this octave or the next) closest to pc.
  let bestDegree = scale[0]!;
  let bestOctaveOffset = 0;
  let bestDist = Infinity;

  for (const degree of scale) {
    for (const oct of [0, 12]) {
      // Allow snapping up into next octave (e.g. pc=11 should snap to next root, not down)
      const d = Math.abs(pc - (degree + oct));
      if (d < bestDist) {
        bestDist = d;
        bestDegree = degree;
        bestOctaveOffset = oct;
      }
    }
  }

  return root + octave * 12 + bestDegree + bestOctaveOffset;
}

/** Format a MIDI note as "C4", "G#5", etc. */
export function midiName(midi: number): string {
  const rounded = Math.round(midi);
  const pc = ((rounded % 12) + 12) % 12;
  const octave = Math.floor(rounded / 12) - 1;
  return `${NOTE_NAMES[pc]}${octave}`;
}

// ----------------------------------------------------------------------------
// Hysteresis snap
// ----------------------------------------------------------------------------
// quantizeToScale() is memoryless: every call returns the nearest scale note.
// If the input sits near the midpoint between two scale notes, tiny frame-to-
// frame jitter (camera noise, tracker wobble) flips the snap back and forth
// each frame, and the carrier glides chase it -- audible as "breakup" on a
// held note.
//
// quantizeToScaleHysteresis() fixes this with asymmetric boundaries:
//   - When the current note is X, the boundary to switch UP is the
//     midpoint(X, X_above) PLUS hystSemi.
//   - The boundary to switch DOWN is midpoint(X, X_below) MINUS hystSemi.
// So there's a dead band of 2*hystSemi around each natural boundary where
// the snap stays put on whichever note we last committed to.
// ----------------------------------------------------------------------------

/**
 * Find the next scale note above and below a given (already-quantized) MIDI
 * note. If `midi` isn't on a scale degree, we bracket it with the nearest
 * degrees on either side.
 */
function adjacentScaleNotes(
  midi: number,
  root: number,
  scale: readonly number[],
): { above: number; below: number } {
  const semitone = midi - root;
  const octave = Math.floor(semitone / 12);
  const pc = ((semitone % 12) + 12) % 12;

  let idx = -1;
  for (let i = 0; i < scale.length; i++) {
    if (scale[i] === pc) {
      idx = i;
      break;
    }
  }

  if (idx < 0) {
    // midi isn't on a scale note. Find the bracketing degrees.
    let loIdx = scale.length - 1;
    let hiIdx = 0;
    let foundHi = false;
    for (let i = 0; i < scale.length; i++) {
      if (scale[i]! < pc) loIdx = i;
      if (scale[i]! > pc && !foundHi) {
        hiIdx = i;
        foundHi = true;
      }
    }
    return {
      above: root + octave * 12 + scale[hiIdx]!,
      below: root + octave * 12 + scale[loIdx]!,
    };
  }

  const above =
    idx === scale.length - 1
      ? root + (octave + 1) * 12 + scale[0]!
      : root + octave * 12 + scale[idx + 1]!;
  const below =
    idx === 0
      ? root + (octave - 1) * 12 + scale[scale.length - 1]!
      : root + octave * 12 + scale[idx - 1]!;

  return { above, below };
}

/**
 * Snap to nearest scale note, but stick to `previousSnap` until the input
 * has crossed the natural midpoint by `hystSemi` extra semitones in either
 * direction. Pass `previousSnap = null` on the first call.
 *
 * @param hystSemi  Hysteresis margin in semitones. 0.3 ≈ small dead band,
 *                  1.0 ≈ very sticky note holds.
 */
export function quantizeToScaleHysteresis(
  midi: number,
  previousSnap: number | null,
  root: number,
  scale: readonly number[],
  hystSemi: number,
): number {
  if (previousSnap === null) return quantizeToScale(midi, root, scale);

  const { above, below } = adjacentScaleNotes(previousSnap, root, scale);
  const upBoundary = (previousSnap + above) / 2 + hystSemi;
  const dnBoundary = (previousSnap + below) / 2 - hystSemi;

  if (midi >= upBoundary || midi <= dnBoundary) {
    return quantizeToScale(midi, root, scale);
  }
  return previousSnap;
}
