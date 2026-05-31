// ============================================================================
// main.ts -- entry point.
// ----------------------------------------------------------------------------
// What this file does today (through Phase 3):
//   1. Wires up the "Start" button (single user gesture: camera + mic + audio).
//   2. Streams camera into a <video> and runs MediaPipe HandLandmarker each
//      frame, drawing up to 2 hand skeletons on a mirrored canvas overlay.
//   3. Builds the audio engine:
//        mic ────► Vocoder.modulatorIn ─┐
//                                       ├─► destination
//        CarrierSynth ► Vocoder.carrierIn ─┘
//      The right hand drives the carrier (wristY -> scale-quantized pitch,
//      pinch -> gate). When the user speaks/sings, the mic's per-band
//      amplitude envelope shapes the carrier's matching bands -- the
//      classic channel-vocoder effect.
//
// What's still to come:
//   - Phase 4: left-hand chord/scale-degree selection, full smoothing.
//   - Phase 5: master FX chain (wet/dry, reverb, limiter) + UI polish.
// ============================================================================

import { createHandTracker, drawHand, type HandTracker } from './handTracking';
import type { Category, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CarrierSynth } from './audio/carrier';
import { Vocoder } from './audio/vocoder';
import { extractFeatures, type HandFeatures } from './gestures';
import { midiName, midiToHz, quantizeToScale } from './audio/scales';
import { MAPPING, currentScale } from './mapping';

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
// Audio engine pieces -- created on Start so the AudioContext has a user
// gesture to authorize playback.
let audioCtx: AudioContext | null = null;
let carrier: CarrierSynth | null = null;
let vocoder: Vocoder | null = null;
let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;

// Current gate state, used to apply hysteresis to the pinch threshold so
// the synth doesn't chatter when the user holds their fingers near the
// boundary.
let gateOpen = false;
// Last MIDI note we sent to the carrier; only logged for debug display.
let lastMidi = 0;

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
// (a) prompt for camera/mic and (b) allow audio playback.
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

    // --- Audio engine -----------------------------------------------------
    // The button click is the user gesture that authorizes audio playback.
    audioCtx = new AudioContext();
    // Some browsers create the context in "suspended" state even after a
    // user gesture; resume() is a no-op if it's already running.
    await audioCtx.resume();

    // Build carrier first so the worklet registration (inside Vocoder.create)
    // is the only async step that gates the wiring.
    carrier = new CarrierSynth(audioCtx);

    setStatus('Loading vocoder…');
    vocoder = await Vocoder.create(audioCtx);

    // Mic -> vocoder modulator input.
    micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(vocoder.modulatorIn);

    // Carrier -> vocoder carrier input.
    carrier.output.connect(vocoder.carrierIn);

    // Vocoder -> speakers.
    vocoder.output.connect(audioCtx.destination);

    running = true;
    setStatus('Ready. Wear headphones! Right hand controls pitch; speak to shape the tone.', 'ok');
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
// Render loop: draw mirrored video frame, run landmark detection, overlay,
// and drive the carrier synth from the right hand.
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
    driveAudio(result.landmarks, result.handedness);
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

// ---------------------------------------------------------------------------
// Audio driver: maps the RIGHT hand's features onto carrier pitch + gate.
// All mapping constants live in mapping.ts so this code stays declarative.
// ---------------------------------------------------------------------------

// Cached features of the right hand for the debug readout.
let lastRightFeatures: HandFeatures | null = null;

function findHand(handedness: Category[][], label: 'Right' | 'Left'): number {
  for (let i = 0; i < handedness.length; i++) {
    if (handedness[i]?.[0]?.categoryName === label) return i;
  }
  return -1;
}

function driveAudio(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
): void {
  if (!carrier) return;

  const rightIdx = findHand(handedness, 'Right');
  if (rightIdx < 0) {
    // No right hand visible: close the gate; leave pitch where it is so the
    // next note doesn't jump weirdly when the hand reappears.
    if (gateOpen) {
      carrier.setGate(false);
      gateOpen = false;
    }
    lastRightFeatures = null;
    return;
  }

  const f = extractFeatures(hands[rightIdx]!);
  lastRightFeatures = f;

  // --- Pitch mapping ----------------------------------------------------
  // wristY: 0 (top) -> midiHigh, 1 (bottom) -> midiLow. We also clamp the
  // small dead-zone bands at the edges where MediaPipe is jittery.
  const { midiLow, midiHigh, yDeadZone } = MAPPING.pitch;
  const yClamped = clamp(f.wristY, yDeadZone, 1 - yDeadZone);
  const yNorm = (yClamped - yDeadZone) / (1 - 2 * yDeadZone); // 0..1
  const rawMidi = midiHigh - yNorm * (midiHigh - midiLow);
  const snapped = quantizeToScale(rawMidi, MAPPING.scale.root, currentScale());
  lastMidi = snapped;
  carrier.setFrequency(midiToHz(snapped));

  // --- Gate mapping (with hysteresis) ----------------------------------
  // Two thresholds prevent the gate from flickering when pinch sits right
  // on the boundary. Open when pinch > pinchOpen; close when pinch < pinchClose.
  const { pinchOpen, pinchClose } = MAPPING.gate;
  if (!gateOpen && f.pinch >= pinchOpen) {
    carrier.setGate(true);
    gateOpen = true;
  } else if (gateOpen && f.pinch <= pinchClose) {
    carrier.setGate(false);
    gateOpen = false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function drawDetections(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
): void {
  for (let i = 0; i < hands.length; i++) {
    const userLabel = handedness[i]?.[0]?.categoryName ?? 'Hand';
    const color = userLabel === 'Right' ? '#5ee0a4' : '#e85ed0';

    drawHand(ctx, hands[i]!, { mirror: true, color });

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
  const lines: string[] = [
    `fps: ${fps.toFixed(1)}    hands: ${hands.length}`,
    `scale: ${MAPPING.scale.name} (root ${MAPPING.scale.root})`,
  ];

  if (vocoder) {
    lines.push(
      `vocoder: ${vocoder.bandFreqs.length} bands, ${vocoder.bandFreqs[0]!.toFixed(0)}-${vocoder.bandFreqs[vocoder.bandFreqs.length - 1]!.toFixed(0)} Hz`,
    );
  }

  if (lastRightFeatures) {
    const hz = midiToHz(lastMidi);
    lines.push(
      `right: y=${lastRightFeatures.wristY.toFixed(2)}  pinch=${lastRightFeatures.pinch.toFixed(2)}  gate=${gateOpen ? 'OPEN' : 'closed'}`,
      `note:  ${midiName(lastMidi)}  (${hz.toFixed(1)} Hz)`,
    );
  } else {
    lines.push('right: (no right hand)');
  }

  // Quick per-hand wrist coordinates, for sanity-checking handedness.
  for (let i = 0; i < hands.length; i++) {
    const userLabel = handedness[i]?.[0]?.categoryName ?? '?';
    const wrist = hands[i]![0];
    lines.push(
      `  [${i}] ${userLabel}  wrist=(${wrist.x.toFixed(2)}, ${wrist.y.toFixed(2)})`,
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
