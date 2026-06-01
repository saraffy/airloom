// ============================================================================
// main.ts -- entry point.
// ----------------------------------------------------------------------------
// What this file does today (through Phase 3, post-tuning):
//   1. Wires up the "Start" button (single user gesture: camera + mic + audio).
//   2. Streams camera into a <video> and runs MediaPipe HandLandmarker each
//      frame, drawing up to 2 hand skeletons on a mirrored canvas overlay.
//      A stabilizer caches landmarks for a few frames so tracker dropouts
//      don't flicker the skeleton (or chop the audio gate).
//   3. Builds the audio engine:
//
//        mic ──> NoiseGate ──> Vocoder.modulatorIn ─┐                  ┌──> destination
//                                                    ├─> Vocoder ──────┤
//        CarrierSynth (always on) ──> Vocoder.carrierIn ┘   (master gate inside)
//
//      The right hand drives pitch+gate:
//        - wristY  -> scale-quantized MIDI note (with hysteresis snap)
//        - pinch   -> master gate on the vocoder output. Closed = TOTAL
//                     silence (vocoded + dry mic together).
//
//      The NoiseGate keeps room noise from driving the vocoder bands.
//      The vocoder's master gate makes "hand down" / "pinch closed" mute
//      everything reachable from the mic, even while talking.
//
// What's still to come:
//   - Phase 4: left-hand chord/scale-degree selection, full smoothing.
//   - Phase 5: master FX chain (wet/dry, reverb, limiter) + UI polish.
// ============================================================================

import {
  createHandStabilizer,
  createHandTracker,
  drawHand,
  filterDelegateLogs,
  type HandStabilizer,
  type HandTracker,
  type InitLogLine,
  type StabilizedResult,
} from './handTracking';
import type { Category, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { CarrierSynth } from './audio/carrier';
import { Vocoder } from './audio/vocoder';
import { NoiseGate } from './audio/noiseGate';
import { extractFeatures, type HandFeatures } from './gestures';
import { midiName, midiToHz, quantizeToScaleHysteresis } from './audio/scales';
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
let stabilizer: HandStabilizer | null = null;
let running = false;
let lastVideoTime = -1;
// Audio engine pieces -- created on Start so the AudioContext has a user
// gesture to authorize playback.
let audioCtx: AudioContext | null = null;
let carrier: CarrierSynth | null = null;
let vocoder: Vocoder | null = null;
let noiseGate: NoiseGate | null = null;
let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;

// Master gate state (right hand visible + pinch open). When false,
// vocoder.setGate(false) is in effect and output is silent.
let gateOpen = false;
// Hangover state for the audio gate. When the stabilized right hand
// disappears we DON'T close the gate immediately -- we start a timer, and
// only close the gate once MAPPING.gate.trackingHoldMs has elapsed without
// the hand reappearing. This decouples audio from tracker jitter so a
// 1-5 frame dropout is completely inaudible.
//
// null = hand currently visible; ms-timestamp = moment it disappeared.
let trackingLostSinceT: number | null = null;

// Last MIDI note we sent to the carrier. Used both for the debug display
// AND as the previous-snap state for pitch hysteresis (so a held hand
// doesn't flip-flop across a scale boundary).
let lastSnappedMidi: number | null = null;
// Number of consecutive frames the snap has been the same. Surfaced in the
// debug panel so you can see hysteresis working: a steady hand should make
// this number climb monotonically into the hundreds.
let snapStableFrames = 0;
// Per-output-hand "age" from the stabilizer (0 = fresh this frame, >0 =
// sticky/cached). Shown in debug.
let lastAges: number[] = [];

// FPS tracking
let frameCount = 0;
let lastFpsT = performance.now();
let fps = 0;

// MediaPipe inference timing. EMA over recent frames. Now reported as a
// raw metric only -- NOT as a delegate guess. Heavy-vs-light-frame
// variation (palm-detection vs landmark model) makes per-frame ms a bad
// signal for which delegate MediaPipe actually loaded.
let avgInferenceMs = 0;
const INF_EMA_ALPHA = 0.1;

// WebGL availability -- a precondition for the GPU delegate. MediaPipe
// silently falls back to CPU when WebGL is unavailable; that fallback
// (or a separate "GPU init failed" event) shows up in the init log.
const gpuAvailable: boolean = checkGpuAvailable();

// Captured at startup. Surfaces both the delegate we asked for AND the
// MediaPipe console output during model load so a silent CPU fallback is
// visible in the UI.
let requestedDelegate: 'GPU' | 'CPU' | null = null;
let initLog: InitLogLine[] = [];
let filteredInitLog: InitLogLine[] = [];

// Cached stabilized result from the last detection frame. drawDetections
// runs every rAF tick using this, so the skeleton stays visible between
// video frames AND on dropped-detection frames (where the stabilizer
// re-injects the cached hand).
let lastStable: StabilizedResult | null = null;
// Tracks the transition between "fresh detection" and "actively bridging"
// so we can console.log when stabilizer engagement begins/ends.
let bridgingActive = false;

function checkGpuAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2') ?? c.getContext('webgl');
    return gl !== null;
  } catch {
    return false;
  }
}

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

    const videoOnly = new MediaStream(stream.getVideoTracks());
    micStream = new MediaStream(stream.getAudioTracks());

    video.srcObject = videoOnly;
    await video.play();

    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    setStatus('Loading hand-landmark model…');
    tracker = await createHandTracker();
    stabilizer = createHandStabilizer(MAPPING.handStickyFrames);

    // Surface the ground-truth delegate + any MediaPipe init warnings
    // (especially "GPU init failed" / "falling back to CPU" style lines).
    requestedDelegate = tracker.requestedDelegate;
    initLog = tracker.initLog;
    filteredInitLog = filterDelegateLogs(initLog);
    console.log(
      `[vocoder] HandLandmarker requestedDelegate=${requestedDelegate}, ` +
        `gpuAvailable=${gpuAvailable}, initLog lines=${initLog.length}, ` +
        `delegate-related lines=${filteredInitLog.length}`,
    );
    if (filteredInitLog.length > 0) {
      console.log('[vocoder] MediaPipe init log (delegate/GPU/WebGL):');
      for (const l of filteredInitLog) console.log(`  [${l.level}] ${l.msg}`);
    }

    // --- Audio engine -----------------------------------------------------
    audioCtx = new AudioContext();
    await audioCtx.resume();

    carrier = new CarrierSynth(audioCtx);
    // Carrier is permanently "on"; the master gate inside the Vocoder is
    // now the single source of truth for audibility.
    carrier.setGate(true);

    setStatus('Loading vocoder…');
    vocoder = await Vocoder.create(audioCtx, MAPPING.vocoder);

    setStatus('Loading noise gate…');
    noiseGate = await NoiseGate.create(audioCtx, MAPPING.noiseGate);

    // Audio graph:  mic -> noiseGate -> vocoder.modulatorIn
    //               carrier -> vocoder.carrierIn
    //               vocoder.output -> destination
    micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(noiseGate.node);
    noiseGate.node.connect(vocoder.modulatorIn);
    carrier.output.connect(vocoder.carrierIn);
    vocoder.output.connect(audioCtx.destination);

    running = true;
    setStatus('Ready. Headphones recommended. Hand up + unpinch + voice = robot.', 'ok');
    requestAnimationFrame(renderLoop);
  } catch (err) {
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
  if (!running || !tracker || !stabilizer) return;

  // Always draw the current video frame.
  ctx.save();
  ctx.scale(-1, 1);
  ctx.drawImage(video, -canvas.width, 0, canvas.width, canvas.height);
  ctx.restore();

  // Detect + reconcile + drive audio ONLY when the video frame has
  // advanced. HandLandmarker requires monotonically-increasing timestamps
  // in VIDEO mode, and there's no point running inference on the same
  // pixels twice. (rAF typically runs at 60Hz; webcam video is ~30Hz.)
  if (video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const t = performance.now();
    const raw = tracker.detect(video, t);
    const inferenceMs = performance.now() - t;
    avgInferenceMs =
      avgInferenceMs === 0
        ? inferenceMs
        : avgInferenceMs * (1 - INF_EMA_ALPHA) + inferenceMs * INF_EMA_ALPHA;

    const stable = stabilizer.reconcile(raw);
    lastStable = stable;
    lastAges = stable.ages;

    // Log when the stabilizer transitions in/out of bridging. This is the
    // direct evidence that the bridge IS engaging on dropped frames.
    const bridging = stable.ages.some((a) => a > 0);
    const rawHadHands = raw.landmarks.length > 0;
    if (bridging && !bridgingActive) {
      console.log(
        `[stabilizer] BRIDGE START -- raw returned ${raw.landmarks.length} hand(s); ` +
          `replaying cached hand(s) at ages=[${stable.ages.join(', ')}]`,
      );
      bridgingActive = true;
    } else if (!bridging && bridgingActive) {
      console.log(`[stabilizer] BRIDGE END -- fresh detection resumed`);
      bridgingActive = false;
    } else if (bridging && !rawHadHands) {
      // Continuing bridge with raw returning no hands -- log per-N frames.
      if (stable.ages[0] !== undefined && stable.ages[0] % 4 === 0) {
        console.log(`[stabilizer] bridging, age=[${stable.ages.join(', ')}]`);
      }
    }

    // Audio + debug update at video-frame rate, NOT rAF rate. Pitch is
    // automatically held on bridged frames because the stabilizer
    // re-emits the same cached landmarks -- extractFeatures yields the
    // same wristY -> same MIDI -> same Hz, and during full hand loss
    // (after stabilizer expires) driveAudio's `rightIdx < 0` branch
    // explicitly skips setFrequency.
    driveAudio(stable.landmarks, stable.handedness);
    updateDebug(stable.landmarks, stable.handedness);
  }

  // Drawing the skeleton runs EVERY rAF tick using the cached stable
  // result. Without this, ticks between video frames re-paint the video
  // over the canvas without re-drawing landmarks, producing a visible
  // 30 Hz strobe; and any frame where reconcile bridged a hand would
  // also render no skeleton because we ran drawDetections only inside
  // the conditional above.
  if (lastStable) {
    drawDetections(lastStable.landmarks, lastStable.handedness, lastStable.ages);
  }

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
  if (!carrier || !vocoder) return;

  const rightIdx = findHand(handedness, 'Right');
  const now = performance.now();

  if (rightIdx < 0) {
    // --- Right hand missing -------------------------------------------
    // Start (or continue) the tracking-loss timer. We DO NOT touch the
    // gate yet -- it stays in whatever state it was in -- so brief
    // dropouts ride straight through with the audio unchanged.
    if (trackingLostSinceT === null) trackingLostSinceT = now;
    const lostMs = now - trackingLostSinceT;

    if (gateOpen && lostMs > MAPPING.gate.trackingHoldMs) {
      // Sustained loss: close the gate for real (smooth ramp).
      vocoder.setGate(false);
      gateOpen = false;
    }
    // Pitch is intentionally left at the last value -- the carrier
    // keeps gliding to it -- so a recovered hand picks up where it
    // left off. lastRightFeatures stays so the debug box keeps the
    // last reading visible.
    return;
  }

  // --- Right hand present ----------------------------------------------
  trackingLostSinceT = null;

  const f = extractFeatures(hands[rightIdx]!);
  lastRightFeatures = f;

  // --- Pitch mapping ----------------------------------------------------
  const { midiLow, midiHigh, yDeadZone, snapHysteresisSemitones } = MAPPING.pitch;
  const yClamped = clamp(f.wristY, yDeadZone, 1 - yDeadZone);
  const yNorm = (yClamped - yDeadZone) / (1 - 2 * yDeadZone);
  const rawMidi = midiHigh - yNorm * (midiHigh - midiLow);
  const snapped = quantizeToScaleHysteresis(
    rawMidi,
    lastSnappedMidi,
    MAPPING.scale.root,
    currentScale(),
    snapHysteresisSemitones,
  );
  if (snapped === lastSnappedMidi) {
    snapStableFrames += 1;
  } else {
    snapStableFrames = 0;
  }
  lastSnappedMidi = snapped;
  carrier.setFrequency(midiToHz(snapped));

  // --- Master gate (vocoder output) with pinch hysteresis ---------------
  // The vocoder.setGate() controls the single master mute that covers
  // BOTH the vocoded carrier path AND the dry-mic blend. Closed = silent.
  const { pinchOpen, pinchClose } = MAPPING.gate;
  if (!gateOpen && f.pinch >= pinchOpen) {
    vocoder.setGate(true);
    gateOpen = true;
  } else if (gateOpen && f.pinch <= pinchClose) {
    vocoder.setGate(false);
    gateOpen = false;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function drawDetections(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
  ages: number[],
): void {
  for (let i = 0; i < hands.length; i++) {
    const userLabel = handedness[i]?.[0]?.categoryName ?? 'Hand';
    const baseColor = userLabel === 'Right' ? '#5ee0a4' : '#e85ed0';
    // Fade slightly when showing a stale (cached) hand so it's obvious
    // when the tracker has briefly lost the hand and we're bridging.
    const age = ages[i] ?? 0;
    const fade = age > 0 ? Math.max(0.4, 1 - age * 0.18) : 1.0;
    ctx.globalAlpha = fade;

    drawHand(ctx, hands[i]!, { mirror: true, color: baseColor });

    const wrist = hands[i]![0];
    if (wrist) {
      const wx = (1 - wrist.x) * canvas.width;
      const wy = wrist.y * canvas.height;
      ctx.fillStyle = baseColor;
      ctx.font = '14px ui-sans-serif, system-ui, sans-serif';
      ctx.fillText(age > 0 ? `${userLabel} (held)` : userLabel, wx + 8, wy - 8);
    }
    ctx.globalAlpha = 1;
  }
}

function updateDebug(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
): void {
  const inferenceFps = avgInferenceMs > 0 ? Math.round(1000 / avgInferenceMs) : 0;

  // Hangover indicator: when the stabilized hand is missing but the gate
  // is still open, we're inside the trackingHoldMs window. Surface this
  // so it's obvious whether you're hearing the hangover hold sound.
  const hangoverMs =
    trackingLostSinceT !== null ? performance.now() - trackingLostSinceT : 0;

  // How many hands in the current frame came from the stabilizer cache
  // (age > 0) vs fresh from MediaPipe (age == 0). This is the direct
  // signal that bridging is engaging.
  const bridgedNow = lastAges.filter((a) => a > 0).length;
  const freshNow = lastAges.filter((a) => a === 0).length;

  const lines: string[] = [
    `fps: ${fps.toFixed(1)}    hands: ${hands.length} (fresh=${freshNow} bridged=${bridgedNow})`,
    // Show the REAL delegate (what we asked for), the WebGL availability,
    // and a count of MediaPipe init-log lines mentioning GPU/CPU/delegate
    // for click-through to console. The timing heuristic is gone.
    `delegate-requested: ${requestedDelegate ?? '?'}  webgl-available: ${gpuAvailable}  init-log: ${initLog.length} lines (${filteredInitLog.length} delegate-related, see console)`,
    `inference: ${avgInferenceMs.toFixed(1)}ms (~${inferenceFps} fps)`,
    `scale: ${MAPPING.scale.name} (root ${MAPPING.scale.root})`,
  ];

  if (vocoder) {
    const compDb = vocoder.getCompressorReductionDb();
    lines.push(
      `vocoder: ${vocoder.bandFreqs.length} bands, ${vocoder.bandFreqs[0]!.toFixed(0)}-${vocoder.bandFreqs[vocoder.bandFreqs.length - 1]!.toFixed(0)} Hz, gate=${gateOpen ? 'OPEN' : 'closed'}, comp=${compDb.toFixed(1)}dB`,
    );
  }
  if (noiseGate) {
    const ng = MAPPING.noiseGate;
    lines.push(
      `noiseGate: open ${ng.openDb ?? -45}dB / close ${ng.closeDb ?? -55}dB / hold ${((ng.holdSec ?? 0.25) * 1000).toFixed(0)}ms`,
    );
  }
  if (hangoverMs > 0) {
    lines.push(
      `hangover: hand lost ${hangoverMs.toFixed(0)}ms ago (hold = ${MAPPING.gate.trackingHoldMs}ms, gate ${gateOpen ? 'still open' : 'closed'})`,
    );
  }

  if (lastRightFeatures) {
    const midi = lastSnappedMidi ?? 0;
    const hz = midiToHz(midi);
    lines.push(
      `right: y=${lastRightFeatures.wristY.toFixed(2)}  pinch=${lastRightFeatures.pinch.toFixed(2)}`,
      `note:  ${midiName(midi)} (${hz.toFixed(1)} Hz)  snap stable for ${snapStableFrames} frames`,
    );
  } else {
    lines.push('right: (no right hand)');
  }

  for (let i = 0; i < hands.length; i++) {
    const userLabel = handedness[i]?.[0]?.categoryName ?? '?';
    const wrist = hands[i]![0];
    const age = lastAges[i] ?? 0;
    lines.push(
      `  [${i}] ${userLabel}  wrist=(${wrist.x.toFixed(2)}, ${wrist.y.toFixed(2)})  age=${age}`,
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
