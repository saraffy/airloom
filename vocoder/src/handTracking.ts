// ============================================================================
// handTracking.ts
// ----------------------------------------------------------------------------
// Wraps MediaPipe Tasks Vision HandLandmarker. Loads the WASM runtime and the
// hand-landmark model from CDN (so we don't ship them in our bundle), then
// exposes a tiny API: createHandTracker() returns an object with .detect(video)
// that runs inference on a video frame and returns the landmarks.
//
// Coordinate system note (important for downstream gesture mapping):
//   - landmark.x and landmark.y are normalized [0,1] in the *original* video
//     frame, where (0,0) is top-left and (1,1) is bottom-right.
//   - We render the camera mirrored (selfie style), so when we draw landmarks
//     onto the canvas we flip x -> (1 - x). The raw .x value from MediaPipe is
//     still the unmirrored coordinate -- gesture code should keep that in mind.
//   - landmark.z is depth relative to the wrist (negative = closer to camera).
// ============================================================================

import {
  HandLandmarker,
  FilesetResolver,
  type Category,
  type HandLandmarkerResult,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision';

// WASM runtime is served locally from /wasm (see vite.config.ts -- the files
// are copied at dev/build time from node_modules/@mediapipe/tasks-vision/wasm).
// Serving locally avoids the missing-wasm-folder issue on some jsDelivr
// versions and the MIME/nosniff errors that come with it.
//
// If you ever want to switch back to CDN, the known-working pin is 0.10.14:
//   const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
// (Avoid 0.10.22 on jsDelivr -- the wasm/ subfolder is not published there.)
const WASM_BASE = '/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export interface HandTracker {
  detect(video: HTMLVideoElement, timestampMs: number): HandLandmarkerResult;
  close(): void;
}

export async function createHandTracker(): Promise<HandTracker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  const landmarker = await HandLandmarker.createFromOptions(fileset, {
    baseOptions: {
      modelAssetPath: MODEL_URL,
      // GPU is faster but may fall back to CPU on some browsers/devices.
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numHands: 2,
    // Confidence thresholds tuned for live performance:
    //   - Detection stays at 0.5 so we don't get spurious hands from noise.
    //   - Presence / tracking lowered to 0.3 so brief confidence dips
    //     (lighting changes, partial occlusion) don't drop the hand entirely.
    //     The hand stabilizer below also bridges the rare full dropouts.
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.3,
    minTrackingConfidence: 0.3,
  });

  return {
    detect(video, timestampMs) {
      return landmarker.detectForVideo(video, timestampMs);
    },
    close() {
      landmarker.close();
    },
  };
}

// ----------------------------------------------------------------------------
// Hand stabilizer
// ----------------------------------------------------------------------------
// Even with relaxed confidence thresholds, MediaPipe occasionally drops a
// hand for a frame or two (lighting blip, partial occlusion, tracker
// re-init). That shows up as the skeleton flickering on and off and -- if
// it's the right hand -- a momentary gate close.
//
// createHandStabilizer() returns a wrapper that caches the last-good
// landmarks per handedness ("Left" / "Right") and re-injects them for up
// to `maxStaleFrames` frames after MediaPipe stops reporting that hand.
// Once a hand has been missing longer than that, it's dropped for real.
// ----------------------------------------------------------------------------

interface CacheEntry {
  landmarks: NormalizedLandmark[];
  handedness: Category[];
  /** Frames since the underlying tracker last reported this hand. 0 = fresh. */
  age: number;
}

export interface StabilizedResult {
  landmarks: NormalizedLandmark[][];
  handedness: Category[][];
  /**
   * Per-output-hand age in frames (0 = fresh this frame, >0 = sticky/cached).
   * Same index as `landmarks` / `handedness`. Useful for UI feedback.
   */
  ages: number[];
}

export interface HandStabilizer {
  reconcile(result: HandLandmarkerResult): StabilizedResult;
  reset(): void;
}

export function createHandStabilizer(maxStaleFrames: number): HandStabilizer {
  let left: CacheEntry | null = null;
  let right: CacheEntry | null = null;

  return {
    reconcile(result: HandLandmarkerResult): StabilizedResult {
      // Age out existing cache. Each entry counts up; if MediaPipe re-sees
      // the hand below, age resets to 0.
      if (left) left.age += 1;
      if (right) right.age += 1;

      // Update cache with what MediaPipe reported this frame.
      for (let i = 0; i < result.landmarks.length; i++) {
        const label = result.handedness[i]?.[0]?.categoryName;
        const entry: CacheEntry = {
          landmarks: result.landmarks[i]!,
          handedness: result.handedness[i]!,
          age: 0,
        };
        if (label === 'Left') left = entry;
        else if (label === 'Right') right = entry;
      }

      const landmarks: NormalizedLandmark[][] = [];
      const handedness: Category[][] = [];
      const ages: number[] = [];

      const push = (e: CacheEntry | null): CacheEntry | null => {
        if (!e) return null;
        if (e.age > maxStaleFrames) return null; // expire
        landmarks.push(e.landmarks);
        handedness.push(e.handedness);
        ages.push(e.age);
        return e;
      };

      left = push(left);
      right = push(right);

      return { landmarks, handedness, ages };
    },
    reset() {
      left = null;
      right = null;
    },
  };
}

// ----------------------------------------------------------------------------
// Hand-skeleton drawing
// ----------------------------------------------------------------------------
// MediaPipe's 21 hand landmarks are indexed 0..20. Below are the
// finger-bone connections we draw as lines. (See MediaPipe docs for the
// canonical hand topology diagram.)
// ----------------------------------------------------------------------------

export const HAND_CONNECTIONS: Array<[number, number]> = [
  // Thumb
  [0, 1], [1, 2], [2, 3], [3, 4],
  // Index
  [0, 5], [5, 6], [6, 7], [7, 8],
  // Middle
  [5, 9], [9, 10], [10, 11], [11, 12],
  // Ring
  [9, 13], [13, 14], [14, 15], [15, 16],
  // Pinky
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export interface DrawHandOptions {
  /** Mirror landmarks horizontally to match the selfie-style flipped video. */
  mirror: boolean;
  /** Color used for the skeleton lines + landmark points. */
  color: string;
  /** Pixel radius of each landmark point. */
  pointRadius?: number;
}

/**
 * Paints the hand skeleton + landmarks onto a 2D canvas context.
 * Caller is responsible for clearing the canvas first.
 */
export function drawHand(
  ctx: CanvasRenderingContext2D,
  landmarks: NormalizedLandmark[],
  opts: DrawHandOptions,
): void {
  const { width, height } = ctx.canvas;
  const pointRadius = opts.pointRadius ?? 4;

  const toCanvasX = (x: number) => (opts.mirror ? (1 - x) * width : x * width);
  const toCanvasY = (y: number) => y * height;

  // Skeleton lines
  ctx.strokeStyle = opts.color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  for (const [a, b] of HAND_CONNECTIONS) {
    const la = landmarks[a];
    const lb = landmarks[b];
    if (!la || !lb) continue;
    ctx.moveTo(toCanvasX(la.x), toCanvasY(la.y));
    ctx.lineTo(toCanvasX(lb.x), toCanvasY(lb.y));
  }
  ctx.stroke();

  // Landmark points
  ctx.fillStyle = opts.color;
  for (const lm of landmarks) {
    ctx.beginPath();
    ctx.arc(toCanvasX(lm.x), toCanvasY(lm.y), pointRadius, 0, Math.PI * 2);
    ctx.fill();
  }
}
