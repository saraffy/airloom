// ============================================================================
// recorder.ts -- capture canvas + processed audio to an MP4 (or WebM).
// ----------------------------------------------------------------------------
// VIDEO source: canvas.captureStream(30). The overlay canvas already has
// the camera + skeleton drawn by drawDetections; the chord-map ladder is
// also painted onto the canvas (ChordMap.drawToCanvas) so it appears in
// recordings.
//
// AUDIO source: a parallel MediaStreamAudioDestinationNode wired off the
// MasterFX output -- the FINAL processed mix (robot / clean / reverb /
// limiter). It's a PARALLEL connection to audioCtx.destination, so live
// audio is unaffected.
//
// FORMAT: tries MP4/H.264+AAC first via MediaRecorder.isTypeSupported().
// Falls back to WebM/VP9+Opus if the browser doesn't support MP4 muxing.
// ffmpeg.wasm transcode was considered but skipped -- it'd add ~30MB to
// the bundle, more than the rest of the app combined.
//
// LATENCY: this module touches audio routing exactly once -- adding a
// non-destructive .connect() on the output node. No worklets, no extra
// processing, no impact on live monitoring latency.
// ============================================================================

export interface RecorderOptions {
  canvas: HTMLCanvasElement;
  /** Final-mix AudioNode. We add a parallel .connect() to a MediaStreamDestination. */
  audioSource: AudioNode;
  audioCtx: AudioContext;
  recordBtn: HTMLButtonElement;
  recordTimer: HTMLElement;
  /** Optional status reporter (e.g. main.ts's setStatus). */
  onStatus?: (msg: string, kind?: 'info' | 'ok' | 'err') => void;
  /** Canvas captureStream framerate. 30 matches the camera; lower saves bytes. */
  fps?: number;
}

export interface RecorderHandle {
  toggle(): void;
  isRecording(): boolean;
  /** Audio-graph tap point used for the recording (for debugging / inspection). */
  readonly audioDestination: MediaStreamAudioDestinationNode;
}

interface PickedMime {
  mime: string;
  ext: 'mp4' | 'webm';
}

/**
 * Try MP4/H.264+AAC variants first, then WebM. MediaRecorder requires
 * specific codec strings on most browsers; the bare `video/mp4` line is
 * a last-resort that some browsers accept.
 */
function pickMimeType(): PickedMime | null {
  const candidates: PickedMime[] = [
    { mime: 'video/mp4;codecs="avc1.42E01E,mp4a.40.2"', ext: 'mp4' },
    { mime: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', ext: 'mp4' },
    { mime: 'video/mp4', ext: 'mp4' },
    { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
    { mime: 'video/webm;codecs=vp8,opus', ext: 'webm' },
    { mime: 'video/webm', ext: 'webm' },
  ];
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      // Some browsers throw on certain MIME strings -- keep going.
    }
  }
  return null;
}

function formatTimestamp(d: Date = new Date()): string {
  const pad = (n: number): string => n.toString().padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

export function createRecorder(opts: RecorderOptions): RecorderHandle {
  // Audio tap: parallel connection to a stream-destination. Live audio
  // still flows to audioCtx.destination via its existing connection -- we
  // don't touch that.
  const audioDestination = opts.audioCtx.createMediaStreamDestination();
  opts.audioSource.connect(audioDestination);

  let recorder: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let chosenMime: PickedMime | null = null;
  let startTimeMs = 0;
  let timerInterval: number | null = null;

  function updateTimerDisplay(): void {
    const elapsedMs = performance.now() - startTimeMs;
    const sec = Math.max(0, Math.floor(elapsedMs / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    opts.recordTimer.textContent = `● ${m}:${s.toString().padStart(2, '0')}`;
  }

  function start(): void {
    if (recorder && recorder.state === 'recording') return;

    chosenMime = pickMimeType();
    if (!chosenMime) {
      opts.onStatus?.(
        'Recording unavailable -- MediaRecorder does not support any video MIME type on this browser.',
        'err',
      );
      return;
    }

    const videoStream = opts.canvas.captureStream(opts.fps ?? 30);
    const combined = new MediaStream([
      ...videoStream.getVideoTracks(),
      ...audioDestination.stream.getAudioTracks(),
    ]);

    chunks = [];
    recorder = new MediaRecorder(combined, { mimeType: chosenMime.mime });

    recorder.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    recorder.onstop = onStop;
    recorder.onerror = (e: Event) => {
      console.error('[recorder] MediaRecorder error:', e);
      opts.onStatus?.('Recording error -- see console.', 'err');
    };

    // 1-second chunks. Frequent enough to capture in case of crash; not so
    // frequent that we get lots of tiny Blobs to concat at stop time.
    recorder.start(1000);
    startTimeMs = performance.now();

    opts.recordBtn.classList.add('recording');
    opts.recordBtn.textContent = '■ Stop';
    opts.recordTimer.classList.remove('hidden');
    updateTimerDisplay();
    timerInterval = window.setInterval(updateTimerDisplay, 250);

    opts.onStatus?.(
      chosenMime.ext === 'mp4'
        ? 'Recording (MP4)…'
        : 'Recording (.webm — this browser does not support MP4 muxing in MediaRecorder)…',
      'info',
    );
  }

  function stop(): void {
    if (recorder && recorder.state === 'recording') recorder.stop();
  }

  function onStop(): void {
    if (!recorder || !chosenMime) return;
    const blob = new Blob(chunks, { type: chosenMime.mime });
    const filename = `gesture-vocoder-${formatTimestamp()}.${chosenMime.ext}`;

    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoke after the download has started.
    setTimeout(() => URL.revokeObjectURL(url), 1500);

    // Reset UI.
    opts.recordBtn.classList.remove('recording');
    opts.recordBtn.textContent = '● Record';
    opts.recordTimer.classList.add('hidden');
    if (timerInterval !== null) {
      clearInterval(timerInterval);
      timerInterval = null;
    }

    const sizeMB = (blob.size / 1024 / 1024).toFixed(1);
    if (chosenMime.ext === 'mp4') {
      opts.onStatus?.(`Saved ${filename} (${sizeMB} MB)`, 'ok');
    } else {
      opts.onStatus?.(
        `Saved ${filename} (${sizeMB} MB). MP4 was unavailable -- this browser's MediaRecorder doesn't support it. ` +
          'Convert with a separate tool if you need MP4.',
        'info',
      );
    }
  }

  return {
    toggle(): void {
      if (recorder && recorder.state === 'recording') stop();
      else start();
    },
    isRecording(): boolean {
      return recorder !== null && recorder.state === 'recording';
    },
    audioDestination,
  };
}
