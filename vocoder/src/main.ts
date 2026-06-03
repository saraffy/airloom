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
import { MasterFX, type MasterMode } from './audio/masterFx';
import { extractFeatures, type HandFeatures } from './gestures';
import {
  chordFromScale,
  midiName,
  midiToHz,
  quantizeToScaleHysteresis,
  NOTE_NAMES,
  type ScaleName,
} from './audio/scales';
import { MAPPING, currentScale } from './mapping';
import { OneEuroFilter, mapRange } from './smoothing';
import { ChordMap } from './chordMap';
import { createRecorder, type RecorderHandle } from './recorder';

// ---------------------------------------------------------------------------
// LATENCY KNOBS
// ---------------------------------------------------------------------------
// Edit these to A/B latency strategies. Both ship at safe defaults --
// reverting individually if a setting hurts is just changing the constant.
// ---------------------------------------------------------------------------

/**
 * Which sample rate should AudioContext run at?
 *   'output' -- no sampleRate pin; browser picks the OS-preferred rate,
 *               which typically matches the output device (e.g. 48000 on
 *               macOS Chrome). The mic input is resampled into the context
 *               (smaller cost than an output-side resample at the same
 *               buffer size, since `outputLatency` is usually the larger
 *               half of total monitoring latency).
 *   'mic'    -- pin to the mic's native rate. Eliminates the input resample
 *               but adds an output resample. Tried on the dev machine;
 *               this approach got 20.8ms total when 'output' might do better.
 *   'default' -- alias for 'output'.
 */
const SAMPLE_RATE_STRATEGY: 'output' | 'mic' | 'default' = 'output';

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------
const video = document.getElementById('video') as HTMLVideoElement;
const canvas = document.getElementById('overlay') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const stageEl = canvas.parentElement as HTMLElement;
const startBtn = document.getElementById('start-btn') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const debugEl = document.getElementById('debug') as HTMLPreElement;
const scaleNameSel = document.getElementById('scale-name') as HTMLSelectElement;
const scaleRootSel = document.getElementById('scale-root') as HTMLSelectElement;
const recordBtn = document.getElementById('record-btn') as HTMLButtonElement;
const recordTimer = document.getElementById('record-timer') as HTMLSpanElement;
const meterGate = document.getElementById('meter-gate') as HTMLDivElement;
const meterNote = document.getElementById('meter-note') as HTMLDivElement;
const meterChord = document.getElementById('meter-chord') as HTMLDivElement;
const meterWet = document.getElementById('meter-wet') as HTMLDivElement;
const meterReverb = document.getElementById('meter-reverb') as HTMLDivElement;

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
let masterFx: MasterFX | null = null;
let micStream: MediaStream | null = null;
let micSource: MediaStreamAudioSourceNode | null = null;
// The mic's native sample rate (from MediaStreamTrack settings). If this
// equals audioCtx.sampleRate, there's no resample between input and graph.
let micSampleRate: number | null = null;

// --- Phase 4: smoothing + chord-extension state -----------------------------
//
// One-euro filters for every continuous gesture value. Created in start()
// with parameters from MAPPING.smoothing. Reset when the corresponding
// hand vanishes so reappearance doesn't trigger a stale-derivative spike.
let smoothRightWristY: OneEuroFilter | null = null;
let smoothLeftOpenness: OneEuroFilter | null = null;
let smoothHandDistance: OneEuroFilter | null = null;

// Left-hand-openness-driven density (0..1). Carrier always plays the full
// triad voicing; this value continuously fades the two UPPER voices
// (third + fifth) in/out. 0 = root only (clean melody line),
// 1 = full triad. Smoothed by the one-euro filter so it doesn't zipper.
let lastDensity = 0;
let lastReverbSend = 0;
// Continuous (pre-snap) MIDI value of the right hand. Used by the
// on-screen chord map to position its hand marker between rungs.
let lastRawMidi: number | null = null;
// Whether the right hand was visible in the most-recently-processed
// detection frame -- distinct from the master mode (which lingers during
// the hangover). The chord-map marker is only shown when this is true.
let rightHandVisibleNow = false;

// The on-screen chord ladder. Built lazily on first start() so the DOM
// is ready, and rebuilt whenever the user changes scale or key.
let chordMap: ChordMap | null = null;

// Recorder. Lazily created on first start() so the AudioContext exists.
let recorder: RecorderHandle | null = null;
// Cached features per side for debug + audio.
let lastLeftFeatures: HandFeatures | null = null;
// Two parallel gain switches between the mic and the vocoder modulator
// so a single key press can A/B the noise gate without touching anything
// else in the graph. See installNoiseGateToggle() below.
let gatedPath: GainNode | null = null;
let bypassPath: GainNode | null = null;
let noiseGateBypassed = false;

// Master mode driven by hand+pinch state. Pinch now toggles the user
// between the vocoded "robot" mix and a CLEAN raw-mic monitor path; hand
// absent (after hangover) closes to silence. setMode crossfades smoothly.
let masterMode: MasterMode = 'silence';
// Pinch hysteresis: true when the user's fingers are touching (clean
// voice monitor). Initial state = false (unpinched / robot).
let pinchClosed = false;
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

// ---------------------------------------------------------------------------
// Noise-gate bypass toggle (press G)
// ---------------------------------------------------------------------------
// Diagnostic switch. The noise gate node always runs (cheap), but when
// "bypassed" its output is faded out and the raw mic is faded in, so the
// vocoder sees unprocessed mic. Useful to confirm whether audible chopping
// is caused by the gate or by something downstream.
function installNoiseGateToggle(): void {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'g' && e.key !== 'G') return;
    if (!audioCtx || !gatedPath || !bypassPath) return;
    // Ignore key events from text inputs (none today, but be safe for later).
    const target = e.target as HTMLElement | null;
    if (target && /input|textarea|select/i.test(target.tagName ?? '')) return;

    noiseGateBypassed = !noiseGateBypassed;
    const t = audioCtx.currentTime;
    const gateTarget = noiseGateBypassed ? 0 : 1;
    const bypTarget = noiseGateBypassed ? 1 : 0;
    // Short crossfade -- avoids click and lets you hear the transition.
    gatedPath.gain.setTargetAtTime(gateTarget, t, 0.01);
    bypassPath.gain.setTargetAtTime(bypTarget, t, 0.01);

    const stateText = noiseGateBypassed ? 'BYPASSED' : 'enabled';
    console.log(`[vocoder] noise gate ${stateText}`);
    setStatus(`Noise gate ${stateText} (press G to toggle)`, noiseGateBypassed ? 'info' : 'ok');
  });
}

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
// Scale picker -- updates MAPPING live and resets the hysteresis snap so
// the pitch re-anchors cleanly to the new scale's notes.
// ---------------------------------------------------------------------------
function installScalePickers(): void {
  scaleNameSel.value = MAPPING.scale.name;
  scaleRootSel.value = String(MAPPING.scale.root);

  scaleNameSel.addEventListener('change', () => {
    MAPPING.scale.name = scaleNameSel.value as ScaleName;
    lastSnappedMidi = null;
    snapStableFrames = 0;
    rebuildChordMap();
    console.log(`[vocoder] scale -> ${MAPPING.scale.name}`);
  });
  scaleRootSel.addEventListener('change', () => {
    MAPPING.scale.root = Number(scaleRootSel.value);
    lastSnappedMidi = null;
    snapStableFrames = 0;
    rebuildChordMap();
    console.log(`[vocoder] root -> ${NOTE_NAMES[MAPPING.scale.root]}`);
  });
}

function rebuildChordMap(): void {
  if (!chordMap) return;
  chordMap.rebuild(
    MAPPING.pitch.midiLow,
    MAPPING.pitch.midiHigh,
    currentScale(),
    MAPPING.scale.root,
  );
}

// ---------------------------------------------------------------------------
// Meter panel -- live, human-readable state. Called each frame.
// ---------------------------------------------------------------------------
function updateChordMap(): void {
  if (!chordMap) return;
  chordMap.update({
    snappedMidi: lastSnappedMidi,
    // Only show the raw-position marker while the right hand is actually
    // visible right now (during hangover we have no fresh hand y so the
    // marker would lie about where the hand is).
    rawMidi: rightHandVisibleNow ? lastRawMidi : null,
    density: lastDensity,
    audible: masterMode !== 'silence',
  });
}

function updateMeters(): void {
  // Mode (was "Gate" - now tri-state: ROBOT / CLEAN / silent)
  meterGate.classList.remove('on', 'off', 'on-clean');
  switch (masterMode) {
    case 'robot':
      meterGate.textContent = 'ROBOT';
      meterGate.classList.add('on');
      break;
    case 'cleanVoice':
      meterGate.textContent = 'CLEAN';
      meterGate.classList.add('on-clean');
      break;
    case 'silence':
      meterGate.textContent = 'silent';
      meterGate.classList.add('off');
      break;
  }

  // Note
  if (lastRightFeatures && lastSnappedMidi !== null) {
    const hz = midiToHz(lastSnappedMidi);
    meterNote.textContent = `${midiName(lastSnappedMidi)}  ${hz.toFixed(0)}Hz`;
  } else {
    meterNote.textContent = '—';
  }

  // Chord (always full 3-note triad on the current root)
  if (lastSnappedMidi !== null) {
    const triad = chordFromScale(
      lastSnappedMidi,
      MAPPING.density.voiceCount,
      currentScale(),
      MAPPING.scale.root,
    );
    meterChord.textContent = triad.map(midiName).join(' ');
  } else {
    meterChord.textContent = '—';
  }

  // Density bar (was Wet; left-hand openness controls density now,
  // wet/dry is fixed at MAPPING.masterFx.initialWet).
  meterWet.style.width = `${Math.round(lastDensity * 100)}%`;
  // Reverb bar
  meterReverb.style.width = `${Math.round(lastReverbSend * 100)}%`;
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
      // ALL voice-call processing OFF:
      //   - echoCancellation, noiseSuppression and autoGainControl each add
      //     buffered processing (tens of ms of input latency) and smear the
      //     modulator. Since the user is on headphones EC isn't needed, and
      //     NS in particular interacts badly with the vocoder's envelope
      //     follower (it pre-gates voice transients we want to capture).
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
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

    // Build the on-screen chord ladder. The dropdowns trigger rebuild()
    // when scale or key changes; nothing else can change the ladder.
    if (!chordMap) {
      chordMap = new ChordMap(stageEl);
    }
    rebuildChordMap();

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
    // Latency strategy:
    //
    // 1. SAMPLE-RATE STRATEGY (see SAMPLE_RATE_STRATEGY constant):
    //      'output' (default): DON'T pin sampleRate. The context runs at
    //         the browser/OS-preferred rate, which is typically the
    //         OUTPUT device's native rate (e.g. 48000 on macOS Chrome).
    //         This eliminates an output-side resample at the cost of a
    //         (smaller) input-side resample for the mic.
    //      'mic': pin to the mic's native rate. Eliminates the input
    //         resample but the output is then resampled. Tried earlier;
    //         on this machine it left total latency around 20ms because
    //         the output buffer dominated.
    //      'default': identical to 'output' (no pin). Kept as a distinct
    //         name so the intent is explicit.
    //
    // 2. latencyHint: 'interactive'. The numeric form (e.g. 0.01) was
    //    tried and BACKFIRED on this machine -- Chrome interpreted the
    //    aggressive request by choosing a LARGER "safe" output buffer,
    //    pushing total latency from ~20ms up to ~38ms. The string hint
    //    'interactive' tells Chrome "give me the lowest you reliably
    //    can" and it picks the right buffer without the negotiation
    //    rebound. Don't change this unless measuring confirms an
    //    improvement on multiple machines.
    const audioTrack = micStream.getAudioTracks()[0];
    const trackSettings = audioTrack?.getSettings();
    micSampleRate = typeof trackSettings?.sampleRate === 'number' ? trackSettings.sampleRate : null;

    const ctxOptions: AudioContextOptions = { latencyHint: 'interactive' };
    if (SAMPLE_RATE_STRATEGY === 'mic' && micSampleRate && micSampleRate > 0) {
      ctxOptions.sampleRate = micSampleRate;
    }
    // 'output' / 'default': no sampleRate option -> browser picks OS rate.

    try {
      audioCtx = new AudioContext(ctxOptions);
    } catch (err) {
      // Browser rejected the requested sampleRate (uncommon but possible).
      // Fall back to interactive hint without pinning rate.
      console.warn('[vocoder] AudioContext rejected sampleRate', ctxOptions.sampleRate, ':', err);
      audioCtx = new AudioContext({ latencyHint: 'interactive' });
    }
    await audioCtx.resume();

    // Polyphonic carrier. With auto-triad we only need 3 voices (root +
    // scale 3rd + scale 5th). All 3 are always assigned a frequency; the
    // density value fades the upper two voices' levels in/out smoothly.
    carrier = new CarrierSynth(audioCtx, { maxVoices: MAPPING.density.voiceCount });

    setStatus('Loading vocoder…');
    vocoder = await Vocoder.create(audioCtx, MAPPING.vocoder);

    setStatus('Loading noise gate…');
    noiseGate = await NoiseGate.create(audioCtx, MAPPING.noiseGate);

    // Master FX chain: wet/dry crossfade between vocoded signal and dry
    // carrier, plus a Phase-5 reverb-send stub.
    masterFx = new MasterFX(audioCtx, MAPPING.masterFx);

    // One-euro smoothing filters per continuous feature. Same params for
    // each since all three are gesture-typed values in [0,1]-ish ranges.
    smoothRightWristY = new OneEuroFilter(MAPPING.smoothing);
    smoothLeftOpenness = new OneEuroFilter(MAPPING.smoothing);
    smoothHandDistance = new OneEuroFilter(MAPPING.smoothing);

    // Audio graph -- latency-optimised (Phase 5+ post-step-3):
    //
    //   mic ─┬────────────────────────────────► vocoder.modulatorIn   (BAND path, raw, no worklet hop)
    //        │
    //        ├─► noiseGate ─► gatedPath (gain=1) ─┐
    //        │                                    ├─► vocoder.dryMicIn (DRY blend, gated)
    //        └─► bypassPath (gain=0) ─────────────┘
    //
    //   carrier ─┬─► vocoder.carrierIn   (vocoding bands)
    //            └─► masterFx.dryCarrierIn (wet/dry crossfade target)
    //   vocoder.output ─► masterFx.vocodedIn
    //   masterFx.output ─► destination
    //
    // Why split: the BAND path drives the audible vocoded carrier and is
    // perceived-latency-critical. Routing it through the noise gate
    // worklet costs ~2.7ms (128 samples @ 48k) for little benefit -- each
    // per-band envelope follower already attenuates the carrier on low
    // inputs. The dry mic blend, however, would leak un-gated room
    // hiss, so the gate stays on THAT path. Bypass toggle (G key)
    // affects dry path only.
    micSource = audioCtx.createMediaStreamSource(micStream);

    // Band path: mic direct to modulator -- saves one worklet hop.
    micSource.connect(vocoder.modulatorIn);

    // Gated-mic path: noise gate (or bypass) feeds TWO targets:
    //   - vocoder.dryMicIn   (currently 0% mix; available if you reactivate
    //                         vocoder.dryMix in MAPPING).
    //   - masterFx.voiceBlendIn (this is the active voice/robot blend; level
    //                            comes from MAPPING.masterFx.voiceBlend).
    // Pressing G crossfades between gated and raw, affecting both targets.
    gatedPath = audioCtx.createGain();
    gatedPath.gain.value = 1;
    bypassPath = audioCtx.createGain();
    bypassPath.gain.value = 0;

    micSource.connect(noiseGate.node);
    noiseGate.node.connect(gatedPath);
    micSource.connect(bypassPath);

    gatedPath.connect(vocoder.dryMicIn);
    bypassPath.connect(vocoder.dryMicIn);
    gatedPath.connect(masterFx.voiceBlendIn);
    bypassPath.connect(masterFx.voiceBlendIn);

    // Carrier feeds BOTH the vocoder (for shaping) AND the MasterFX dry
    // path (for the openness-controlled wet/dry blend). These are parallel
    // taps off the same CarrierSynth output -- the vocoder doesn't see
    // the dry tap and vice versa.
    carrier.output.connect(vocoder.carrierIn);
    carrier.output.connect(masterFx.dryCarrierIn);
    vocoder.output.connect(masterFx.vocodedIn);

    // Clean-voice monitor: raw mic straight to masterFx.cleanVoiceIn.
    // Only audible when masterFx.setMode('cleanVoice') is active (pinched).
    micSource.connect(masterFx.cleanVoiceIn);

    masterFx.output.connect(audioCtx.destination);

    // The vocoder's internal master gate is now redundant -- MasterFX
    // handles muting via setMode. Open the vocoder gate permanently so
    // the vocoded signal flows whenever MasterFX wants it.
    vocoder.setGate(true);

    // Wire up the recorder. The audio tap is a parallel connection off
    // masterFx.output to a MediaStreamAudioDestination -- live audio
    // path through audioCtx.destination is untouched. Canvas video is
    // captured via canvas.captureStream(30); ChordMap.drawToCanvas in
    // the render loop ensures the chord ladder appears in the recording.
    if (!recorder) {
      recorder = createRecorder({
        canvas,
        audioSource: masterFx.output,
        audioCtx,
        recordBtn,
        recordTimer,
        onStatus: setStatus,
      });
      recordBtn.disabled = false;
      recordBtn.addEventListener('click', () => {
        recorder?.toggle();
      });
    }

    installNoiseGateToggle();

    // Surface the actual platform latency once everything is wired.
    const base = audioCtx.baseLatency * 1000;
    const out = (audioCtx.outputLatency ?? 0) * 1000;
    const resampling = micSampleRate !== null && micSampleRate !== audioCtx.sampleRate;
    console.log(
      `[vocoder] audio: strategy=${SAMPLE_RATE_STRATEGY} ` +
        `mic=${micSampleRate ?? '?'}Hz ctx=${audioCtx.sampleRate}Hz ` +
        `resampling=${resampling} ` +
        `baseLatency=${base.toFixed(2)}ms outputLatency=${out.toFixed(2)}ms ` +
        `total=${(base + out).toFixed(2)}ms latencyHint=interactive`,
    );

    running = true;
    setStatus('Ready. Headphones recommended. Press G to toggle noise gate bypass.', 'ok');
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
    updateMeters();
    updateChordMap();
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

  // Paint the chord ladder onto the canvas as well. The DOM overlay sits
  // visually on top (so live viewing keeps the styled HTML look), but
  // canvas.captureStream() only sees pixels -- this is what makes the
  // chord map appear in recordings.
  if (chordMap) {
    chordMap.drawToCanvas(ctx, {
      snappedMidi: lastSnappedMidi,
      rawMidi: rightHandVisibleNow ? lastRawMidi : null,
      density: lastDensity,
      audible: masterMode !== 'silence',
    });
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

function setMasterMode(target: MasterMode): void {
  if (!masterFx || masterMode === target) return;
  masterFx.setMode(target);
  masterMode = target;
}

function driveAudio(
  hands: NormalizedLandmark[][],
  handedness: Category[][],
): void {
  if (!carrier || !vocoder || !masterFx) return;

  const now = performance.now();
  const rightIdx = findHand(handedness, 'Right');
  const leftIdx = findHand(handedness, 'Left');

  // -----------------------------------------------------------------------
  // LEFT HAND: openness -> harmonic density (root-only ↔ full triad).
  // No finger-counting anymore. The carrier always plays a 3-note diatonic
  // triad on the right-hand root note; openness continuously crossfades
  // the two upper voices (third + fifth) in/out via per-voice gain.
  // -----------------------------------------------------------------------
  if (leftIdx >= 0) {
    const lf = extractFeatures(hands[leftIdx]!);
    lastLeftFeatures = lf;

    const smOpenness = smoothLeftOpenness!.filter(lf.openness, now);
    const { opennessMin, opennessMax } = MAPPING.density;
    lastDensity = mapRange(smOpenness, opennessMin, opennessMax, 0, 1);
  } else {
    lastLeftFeatures = null;
    smoothLeftOpenness?.reset();
    // Density held at its last value -- when the hand reappears it picks
    // up where it left off rather than jumping.
  }

  // -----------------------------------------------------------------------
  // TWO-HAND DISTANCE: horizontal -> reverb send level (placeholder until
  // Phase 5 wires the actual ConvolverNode).
  // -----------------------------------------------------------------------
  if (leftIdx >= 0 && rightIdx >= 0) {
    const lWristX = hands[leftIdx]![0]!.x;
    const rWristX = hands[rightIdx]![0]!.x;
    const rawDist = Math.abs(lWristX - rWristX);
    const smDist = smoothHandDistance!.filter(rawDist, now);
    const { distanceMin, distanceMax, sendMin, sendMax, curveExp } = MAPPING.reverbSend;
    // Normalize to [0,1], bend with a power curve so the response feels
    // dramatic (subtle at small/medium separation, blooming near full arms-wide).
    const tNorm = mapRange(smDist, distanceMin, distanceMax, 0, 1);
    const curved = Math.pow(tNorm, curveExp);
    const send = sendMin + (sendMax - sendMin) * curved;
    masterFx.setReverbSend(send);
    // Same curved value drives the SHORT->LONG IR crossfade so the tail
    // GROWS with distance, not just gets louder.
    masterFx.setTailLength(curved);
    lastReverbSend = send;
  } else {
    // Only one hand visible: no send, collapse to short tail.
    masterFx.setReverbSend(0);
    masterFx.setTailLength(0);
    lastReverbSend = 0;
    smoothHandDistance?.reset();
  }

  // -----------------------------------------------------------------------
  // RIGHT HAND: pitch + master gate. The audio gate hangover from Phase 3
  // is unchanged; chord voicing comes from chordSize above.
  // -----------------------------------------------------------------------
  if (rightIdx < 0) {
    rightHandVisibleNow = false;
    if (trackingLostSinceT === null) trackingLostSinceT = now;
    const lostMs = now - trackingLostSinceT;

    if (masterMode !== 'silence' && lostMs > MAPPING.gate.trackingHoldMs) {
      setMasterMode('silence');
    }
    // Pitch and chord voicing are intentionally left at last values --
    // the carrier holds whatever it was playing so a recovered hand
    // resumes without a phase glitch. lastRightFeatures stays for debug.
    smoothRightWristY?.reset();
    return;
  }

  rightHandVisibleNow = true;
  trackingLostSinceT = null;

  const f = extractFeatures(hands[rightIdx]!);
  lastRightFeatures = f;

  // --- Pitch mapping with one-euro smoothing on wristY ------------------
  // Smoothing happens BEFORE the hysteresis snap. The snap still has its
  // own dead-band, but a smoother input means fewer boundary crossings
  // during slow deliberate motion.
  const { midiLow, midiHigh, yDeadZone, snapHysteresisSemitones } = MAPPING.pitch;
  const smY = smoothRightWristY!.filter(f.wristY, now);
  const yClamped = clamp(smY, yDeadZone, 1 - yDeadZone);
  const yNorm = (yClamped - yDeadZone) / (1 - 2 * yDeadZone);
  const rawMidi = midiHigh - yNorm * (midiHigh - midiLow);
  lastRawMidi = rawMidi;
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

  // --- Auto-triad with density-controlled upper-voice gain --------------
  // Always build a 3-note diatonic triad on the snapped root. The root
  // voice is always at full gain (the melody line you'd hear at density=0);
  // the third and fifth fade in continuously with the density value.
  const triadMidis = chordFromScale(
    snapped,
    MAPPING.density.voiceCount, // 3
    currentScale(),
    MAPPING.scale.root,
  );
  const freqs = triadMidis.map(midiToHz);
  // levels: root always full; upper two scale with density.
  const levels = [1, lastDensity, lastDensity];
  carrier.setVoicesWithLevels(freqs, levels);

  // --- Mode crossfade driven by pinch with hysteresis ------------------
  //   pinch HIGH (fingers spread, "unpinched") -> robot mix
  //   pinch LOW  (fingers touching, "pinched") -> clean voice monitor
  // Uses the same threshold pair as the old pinch-gate, but the SEMANTICS
  // are inverted: pinch is now a positive "monitor my real voice" gesture
  // rather than a "mute" gesture.
  const { pinchOpen, pinchClose } = MAPPING.gate;
  if (!pinchClosed && f.pinch <= pinchClose) {
    pinchClosed = true;
  } else if (pinchClosed && f.pinch >= pinchOpen) {
    pinchClosed = false;
  }
  setMasterMode(pinchClosed ? 'cleanVoice' : 'robot');
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

  // Live audio latency. baseLatency is the input buffer (browser-side);
  // outputLatency (when implemented) is the output buffer. Sum is the
  // round-trip monitoring delay floor -- the rest is per-node processing
  // (noise gate + envelope follower add one quantum each ~ 2.7ms at 48k).
  let latencyLine = '';
  if (audioCtx) {
    const baseMs = audioCtx.baseLatency * 1000;
    const outMs = (audioCtx.outputLatency ?? 0) * 1000;
    const ctxSr = audioCtx.sampleRate;
    const srInfo =
      micSampleRate && micSampleRate !== ctxSr
        ? `${ctxSr}Hz (mic=${micSampleRate}Hz, RESAMPLING, strategy=${SAMPLE_RATE_STRATEGY})`
        : micSampleRate
          ? `${ctxSr}Hz (mic-matched, strategy=${SAMPLE_RATE_STRATEGY})`
          : `${ctxSr}Hz`;
    latencyLine = `audio: sr=${srInfo}  base=${baseMs.toFixed(1)}ms  output=${outMs.toFixed(1)}ms  total=${(baseMs + outMs).toFixed(1)}ms`;
  }

  const lines: string[] = [
    `fps: ${fps.toFixed(1)}    hands: ${hands.length} (fresh=${freshNow} bridged=${bridgedNow})`,
    // Show the REAL delegate (what we asked for), the WebGL availability,
    // and a count of MediaPipe init-log lines mentioning GPU/CPU/delegate
    // for click-through to console. The timing heuristic is gone.
    `delegate-requested: ${requestedDelegate ?? '?'}  webgl-available: ${gpuAvailable}  init-log: ${initLog.length} lines (${filteredInitLog.length} delegate-related, see console)`,
    `inference: ${avgInferenceMs.toFixed(1)}ms (~${inferenceFps} fps)`,
    latencyLine,
    `scale: ${MAPPING.scale.name} (root ${MAPPING.scale.root})`,
  ];

  if (vocoder) {
    const compDb = vocoder.getCompressorReductionDb();
    lines.push(
      `vocoder: ${vocoder.bandFreqs.length} bands, ${vocoder.bandFreqs[0]!.toFixed(0)}-${vocoder.bandFreqs[vocoder.bandFreqs.length - 1]!.toFixed(0)} Hz, mode=${masterMode}, comp=${compDb.toFixed(1)}dB`,
    );
  }
  if (noiseGate) {
    const ng = MAPPING.noiseGate;
    lines.push(
      `noiseGate: open ${ng.openDb ?? -45}dB / close ${ng.closeDb ?? -60}dB / hold ${((ng.holdSec ?? 0.4) * 1000).toFixed(0)}ms  ${noiseGateBypassed ? '(BYPASSED -- press G)' : '(active -- press G to bypass)'}`,
    );
  }
  if (masterFx) {
    lines.push(
      `voice blend: ${(masterFx.voiceBlendValue * 100).toFixed(0)}% (MAPPING.masterFx.voiceBlend; ROBOT mode only)`,
    );
  }
  if (hangoverMs > 0) {
    lines.push(
      `hangover: hand lost ${hangoverMs.toFixed(0)}ms ago (hold = ${MAPPING.gate.trackingHoldMs}ms, mode=${masterMode})`,
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

  // Left hand: openness -> density mapping.
  if (lastLeftFeatures) {
    const densityLabel =
      lastDensity < 0.05 ? 'mono root'
      : lastDensity > 0.95 ? 'full triad'
      : 'mono ↔ triad';
    lines.push(
      `left:  openness=${lastLeftFeatures.openness.toFixed(2)}  density=${(lastDensity * 100).toFixed(0)}% (${densityLabel})`,
    );
  } else {
    lines.push('left:  (no left hand) -- density held');
  }
  if (lastSnappedMidi !== null && carrier) {
    const triadMidis = chordFromScale(
      lastSnappedMidi,
      MAPPING.density.voiceCount,
      currentScale(),
      MAPPING.scale.root,
    );
    const audibleLevels = [1, lastDensity, lastDensity].map((l) => (l * 100).toFixed(0) + '%');
    lines.push(`triad: [${triadMidis.map(midiName).join(', ')}] @ [${audibleLevels.join(', ')}]`);
  }
  const fixedWet = masterFx ? masterFx.wetLevel : MAPPING.masterFx.initialWet ?? 1;
  const tail = masterFx ? masterFx.tailLength : 0;
  lines.push(
    `master: wet=${(fixedWet * 100).toFixed(0)}% (fixed)  reverbSend=${(lastReverbSend * 100).toFixed(0)}%  tail=${(tail * 100).toFixed(0)}% (short↔long)`,
  );

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
installScalePickers();
startBtn.addEventListener('click', () => {
  void start();
});
