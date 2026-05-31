// ============================================================================
// main.ts -- Phase 1 entry point.
// ----------------------------------------------------------------------------
// What this file does today (Phase 1):
//   1. Wires up the "Start" button.
//   2. Requests camera access (mic is requested too, so the Phase-3 vocoder
//      can use it later without a second permission prompt).
//   3. Streams the camera into a <video> and starts a render loop that:
//        - draws the video frame onto the overlay canvas (mirrored), and
//        - runs MediaPipe HandLandmarker, drawing up to 2 hand skeletons.
//
// What this file will grow into:
//   - Phase 2 wires the hand landmarks to a Web Audio carrier synth.
//   - Phase 3 introduces the mic-driven vocoder AudioWorklet.
//   - Phase 4/5 add the gesture-mapping config, smoothing, master FX, UI.
// ============================================================================

import { createHandTracker, drawHand, type HandTracker } from './handTracking';
import type { Category, NormalizedLandmark } from '@mediapipe/tasks-vision';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const debugEl = document.getElementById('debug') as HTMLPreElement;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let tracker: HandTracker | null = null;
let running = false;
let lastVideoTime = -1;
// Holds the audio MediaStreamTrack we keep alive for Phase 3 (mic).
let micStream: MediaStream | null = null;
// FPS tracking
let frameCount = 0;
let lastFpsT = performance.now();
let fps = 0;

function setStatus(msg: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
  statusEl.textContent = msg;
  statusEl.classList.remove('ok', 'err');
  if (kind === 'ok') statusEl.classList.add('ok');
  if (kind === 'err') statusEl.classList.add('err');
}

// ---------------------------------------------------------------------------
// Start flow -- requires a user gesture (button click) so the browser will
// (a) prompt for camera/mic and (b) allow audio later in Phase 2+.
// ---------------------------------------------------------------------------
async function start(): Promise<void> {
  if (running) return;
  startBtn.disabled = true;
  setStatus('Requesting camera + mic permissions…');

  try {
    // Ask for camera AND mic up-front so we don't double-prompt later when
    // Phase 3 wires up the vocoder.
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: 640 },
        height: { ideal: 480 },
        facingMode: 'user',
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: false, // we want the raw voice for the vocoder
        autoGainControl: false,
      },
    });

    // Split video and audio: the <video> only needs video tracks.
    const videoOnly = new MediaStream(stream.getVideoTracks());
    micStream = new MediaStream(stream.getAudioTracks());
    void micStream; // silence "unused" until Phase 3 consumes it

    video.srcObject = videoOnly;
    await video.play();

    // Match canvas pixel size to the actual video resolution. We do this
    // *after* play() so video.videoWidth/Height are populated.
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    setStatus('Loading hand-landmark model…');
    tracker = await createHandTracker();

    running = true;
    setStatus('Tracking. Wave at the camera.', 'ok');
    requestAnimationFrame(renderLoop);
  } catch (err) {
    // MediaPipe + getUserMedia can throw DOMException, plain objects, or
    // strings -- not always proper Error instances. Coerce to a readable
    // message so the UI never shows "undefined".
    console.error('Failed to start:', err);
    const message = describeError(err);
    setStatus(`Failed to start: ${message}`, 'err');
    startBtn.disabled = false;
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // DOMException uses .name for things like "NotAllowedError" -- include it
    // for clarity when .message is empty or generic.
    return err.name && err.name !== 'Error'
      ? `${err.name}: ${err.message || '(no message)'}`
      : err.message || err.name || '(no message — see console)';
  }
  if (typeof err === 'string' && err.length > 0) return err;
  if (err && typeof err === 'object') {
    const maybe = err as { message?: unknown; name?: unknown };
    if (typeof maybe.message === 'string' && maybe.message) return maybe.message;
    if (typeof maybe.name === 'string' && maybe.name) return maybe.name;
    try {
      return JSON.stringify(err);
    } catch {
      // fall through
    }
  }
  return '(no message — see console)';
}

// ---------------------------------------------------------------------------
// Render loop: draw mirrored video frame, run landmark detection, overlay.
// ---------------------------------------------------------------------------
function renderLoop(): void {
  if (!running || !tracker) return;

  // Draw video frame (mirrored horizontally for selfie-style feedback).
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();

  // Only run inference when we have a new frame (HandLandmarker requires
  // monotonically-increasing timestamps in VIDEO mode).
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const t = performance.now();
    const result = tracker.detect(video, t);
    drawDetections(result.landmarks, result.handedness);
    updateDebug(result.landmarks, result.handedness);
  }

  // FPS tally
  frameCount += 1;
  const now = performance.now();
  if (now - lastFpsT >= 500) {
    fps = (frameCount * 1000) / (now - lastFpsT);
    frameCount = 0;
    lastFpsT = now;
  }

  requestAnimationFrame(renderLoop);
}

function drawDetections(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
): void {
  for (let i = 0; i < hands.length; i++) {
    // MediaPipe reports handedness from the camera's POV. Because we mirror
    // the video, "Right" in the result is actually the user's LEFT hand
    // and vice versa -- so for *display labels* we swap. The raw label is
    // still useful for gesture mapping; we'll deal with that in Phase 4.
    const rawLabel = handedness[i]?.[0]?.categoryName ?? 'Hand';
    const userLabel = rawLabel === 'Right' ? 'Left' : rawLabel === 'Left' ? 'Right' : rawLabel;

    // Color by user-perspective hand: right = mint, left = magenta.
    const color = userLabel === 'Right' ? '#5ee0a4' : '#e85ed0';

    drawHand(ctx, hands[i]!, { mirror: true, color });

    // Tag the wrist with the label so it's obvious which hand is which.
    const wrist = hands[i]![0];
    if (wrist) {
      const wx = (1 - wrist.x) * canvas.width;
      const wy = wrist.y * canvas.height;
      ctx.fillStyle = color;
      ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(userLabel, wx + 8, wy - 8);
    }
  }
}

function updateDebug(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
): void {
  const lines: string[] = [`fps: ${fps.toFixed(1)}`, `hands: ${hands.length}`];
  for (let i = 0; i < hands.length; i++) {
    const label = handedness[i]?.[0]?.categoryName ?? '?';
    const userLabel = label === 'Right' ? 'Left' : label === 'Left' ? 'Right' : label;
    const wrist = hands[i]![0];
    lines.push(
      `  [${i}] user=${userLabel}  wrist=(${wrist.x.toFixed(2)}, ${wrist.y.toFixed(2)})`,
    );
  }
  debugEl.textContent = lines.join('\n');
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
startBtn.addEventListener('click', () => {
  void start();
});
