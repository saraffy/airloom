// ============================================================================
// gestures.ts -- extract numeric features from a hand's 21 landmarks.
// ----------------------------------------------------------------------------
// MediaPipe gives us a flat array of 21 (x, y, z) points per hand, normalized
// to the input frame. We convert that to *gesture* values that the audio
// engine can use: vertical position, pinch distance, hand openness, finger
// counts.
//
// Coordinate notes:
//   - x, y are in [0, 1]; (0,0) is top-left of the UNMIRRORED frame.
//   - Phase 2 only needs wristY and pinch. Other features are stubbed in
//     here so Phase 4 can light them up without restructuring this module.
// ============================================================================

import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

// MediaPipe hand-landmark indices. See:
// https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker
export const LM = {
  WRIST: 0,
  THUMB_CMC: 1,
  THUMB_MCP: 2,
  THUMB_IP: 3,
  THUMB_TIP: 4,
  INDEX_MCP: 5,
  INDEX_PIP: 6,
  INDEX_DIP: 7,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_DIP: 11,
  MIDDLE_TIP: 12,
  RING_MCP: 13,
  RING_PIP: 14,
  RING_DIP: 15,
  RING_TIP: 16,
  PINKY_MCP: 17,
  PINKY_PIP: 18,
  PINKY_DIP: 19,
  PINKY_TIP: 20,
} as const;

export interface FingerExtensionRatios {
  /** Thumb tip distance to index-MCP, palm-normalized. */
  thumb: number;
  /** Each finger: tip-to-MCP distance, palm-normalized. */
  index: number;
  middle: number;
  ring: number;
  pinky: number;
}

export interface HandFeatures {
  /** Wrist y in [0, 1]. 0 = top of frame, 1 = bottom. */
  wristY: number;
  /** Wrist x in [0, 1]. UNMIRRORED -- camera-frame coordinates. */
  wristX: number;
  /**
   * Pinch distance: thumb-tip to index-tip, normalized by hand size so the
   * value is invariant to how close/far the hand is from the camera.
   * Typical range: ~0.05 (touching) to ~1.2 (fully spread).
   */
  pinch: number;
  /**
   * Mean fingertip-to-wrist distance, normalized by hand size. Higher =
   * spread fingers. Range roughly 0.8 (fist) to 3.5 (fully splayed palm).
   */
  openness: number;
  /**
   * Per-finger extension ratios. main.ts applies hysteresis to derive a
   * stable boolean "extended" state per finger.
   */
  fingerRatios: FingerExtensionRatios;
}

/**
 * Compute features for a single hand. Caller has already determined which
 * hand this is via MediaPipe handedness.
 */
export function extractFeatures(landmarks: NormalizedLandmark[]): HandFeatures {
  const wrist = landmarks[LM.WRIST]!;
  const middleMcp = landmarks[LM.MIDDLE_MCP]!;
  const thumbTip = landmarks[LM.THUMB_TIP]!;
  const indexTip = landmarks[LM.INDEX_TIP]!;
  const indexMcp = landmarks[LM.INDEX_MCP]!;
  const middleTip = landmarks[LM.MIDDLE_TIP]!;
  const ringTip = landmarks[LM.RING_TIP]!;
  const ringMcp = landmarks[LM.RING_MCP]!;
  const pinkyTip = landmarks[LM.PINKY_TIP]!;
  const pinkyMcp = landmarks[LM.PINKY_MCP]!;

  // Reference distance: wrist -> middle-finger knuckle. This roughly equals
  // the length of the palm and scales with how close the hand is to the
  // camera, so dividing other distances by it gives scale-invariant ratios.
  const palmLen = dist(wrist, middleMcp) || 1e-6;

  const pinch = dist(thumbTip, indexTip) / palmLen;

  // openness: mean distance from each fingertip to the wrist, palm-normalized.
  const tips = [LM.THUMB_TIP, LM.INDEX_TIP, LM.MIDDLE_TIP, LM.RING_TIP, LM.PINKY_TIP];
  let openSum = 0;
  for (const i of tips) openSum += dist(wrist, landmarks[i]!);
  const openness = openSum / (tips.length * palmLen);

  // Per-finger extension ratios. For four fingers, we compare the tip
  // against the MCP knuckle: extended ~> 0.8 palm-lengths, curled <~ 0.4.
  // The thumb is geometrically different -- it folds across the palm
  // rather than curling at MCP -- so we compare its tip to the INDEX
  // MCP instead. Extended thumb sticks out away from that joint; curled
  // thumb (tucked across palm) sits close.
  const fingerRatios: FingerExtensionRatios = {
    thumb: dist(thumbTip, indexMcp) / palmLen,
    index: dist(indexTip, indexMcp) / palmLen,
    middle: dist(middleTip, middleMcp) / palmLen,
    ring: dist(ringTip, ringMcp) / palmLen,
    pinky: dist(pinkyTip, pinkyMcp) / palmLen,
  };

  return {
    wristY: wrist.y,
    wristX: wrist.x,
    pinch,
    openness,
    fingerRatios,
  };
}

function dist(a: NormalizedLandmark, b: NormalizedLandmark): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}
