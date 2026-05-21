const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const splash = document.getElementById('splash');
const startBtn = document.getElementById('startBtn');

let audioInitialized = false;
let cameraActive = false;

let mediaRecorder = null;
let recordingChunks = [];
let audioRecordDest = null;
let isRecording = false;

let synth = null;
let pad = null;
let masterGain = null;
let filter = null;
let distortion = null;
let vibrato = null;
let reverb = null;
let delay = null;
let chorus = null;

const SCALES = {
  'C Major':      { root: 261.63, intervals: [0,2,4,5,7,9,11], noteNames: ['C','D','E','F','G','A','B'] },
  'G Major':      { root: 196.00, intervals: [0,2,4,5,7,9,11], noteNames: ['G','A','B','C','D','E','F#'] },
  'A Minor':      { root: 220.00, intervals: [0,2,3,5,7,8,10], noteNames: ['A','B','C','D','E','F','G'] },
  'F Major':      { root: 174.61, intervals: [0,2,4,5,7,9,11], noteNames: ['F','G','A','Bb','C','D','E'] },
  'C Pentatonic': { root: 261.63, intervals: [0,2,4,7,9],       noteNames: ['C','D','E','G','A'] },
  'A Pentatonic': { root: 220.00, intervals: [0,3,5,7,10],      noteNames: ['A','C','D','E','G'] },
  'A Blues':      { root: 220.00, intervals: [0,3,5,6,7,10],    noteNames: ['A','C','D','Eb','E','G'] },
};
let currentNotes = [];
let extendedScaleNotes = [];
let currentScale = 'C Major';

const CHORD_SCALE_STEPS = {
  major: [0, 2, 4],
  minor: [0, 2, 4],
  sus2:  [0, 1, 4],
  sus4:  [0, 3, 4],
};

const particles = [];

class Particle {
  constructor(x, y, freq) {
    this.x = x;
    this.y = y;
    this.vx = (Math.random() - 0.5) * 2;
    this.vy = (Math.random() - 0.5) * 2;
    this.life = 1;
    this.freq = freq;
  }

  update() {
    this.x += this.vx;
    this.y += this.vy;
    this.life -= 0.02;
  }

  draw(ctx) {
    if (this.life <= 0) return;
    const hue = Math.floor((this.freq - 110) / 770 * 360) % 360;
    ctx.fillStyle = `hsla(${hue}, 100%, 50%, ${this.life * 0.6})`;
    ctx.beginPath();
    ctx.arc(this.x, this.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function spawnParticle(x, y, freq) {
  particles.push(new Particle(x, y, freq));
  if (particles.length > 40) {
    particles.shift();
  }
}

const HUD = {
  detected: document.getElementById('hudDetected'),
  palmX: document.getElementById('hudPalmX'),
  palmY: document.getElementById('hudPalmY'),
  open: document.getElementById('hudOpen'),
  pinch: document.getElementById('hudPinch'),
  speed: document.getElementById('hudSpeed'),
  freq: document.getElementById('hudFreq'),
  note: document.getElementById('hudNote'),
  chord: document.getElementById('hudChord'),
};

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    video.onloadedmetadata = () => {
      console.log('Video metadata loaded, size:', video.videoWidth, 'x', video.videoHeight);
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      cameraActive = true;
      console.log('Camera is now ACTIVE, starting ml5.js...');
      initHandDetection();
    };
  } catch (err) {
    console.error('Camera access denied:', err);
    console.log('Falling back to mouse control...');
    enableMouseControl();
  }
}

function enableMouseControl() {
  updateFromMouse();
}

function buildScaleNotes(scale, multiplier = 1) {
  const { root, intervals } = scale;
  const notes = [];
  for (const interval of intervals) {
    notes.push(root * multiplier * Math.pow(2, interval / 12));
  }
  return notes;
}

async function initAudio(reverbDecay = 2.5, reverbWet = 0.4, delayTime = 0.25, delayFeedback = 0.3, delayWet = 0.2, instrument = 'ethereal') {
  if (audioInitialized) return;
  audioInitialized = true;

  if (vocalModeEnabled) {
    Tone.context.lookAhead = 0.005;
  }

  await Tone.start();

  masterGain = new Tone.Gain(0.5).toDestination();
  reverb = new Tone.Reverb({ decay: reverbDecay, wet: vocalModeEnabled ? 0 : reverbWet, preDelay: 0 });
  delay = new Tone.FeedbackDelay({ delayTime, feedback: delayFeedback, wet: delayWet });

  await reverb.ready;

  const INSTRUMENT_PRESETS = {
    ethereal: {
      oscillator: { type: 'sine' },
      envelope:   { attack: 1.2, decay: 0.5, sustain: 0.8, release: 3.0 },
      useChorus:  true,
    },
    organ: {
      oscillator: { type: 'square' },
      envelope:   { attack: 0.01, decay: 0.1, sustain: 1.0, release: 0.1 },
      useChorus:  false,
    },
    piano: {
      oscillator: { type: 'triangle' },
      envelope:   { attack: 0.005, decay: 1.5, sustain: 0.2, release: 1.2 },
      useChorus:  false,
    },
  };

  const preset = INSTRUMENT_PRESETS[instrument];

  if (vocalModeEnabled) {
    try {
      console.log('🎤 Requesting microphone access...');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log('✅ Microphone permission granted');

      vocalTremolo = new Tone.Tremolo({ frequency: 2, depth: 0.8, wet: 0 }).start();
      vocalChorus = new Tone.Chorus({ frequency: 1.5, delayTime: 1.0, depth: 0.75, wet: 0 });
      vocalChorus.start();
      const mixerGain = new Tone.Gain(1);
      directGain = new Tone.Gain(0.9);
      const intervals = [7, -7, -14];
      harmonyShifts = intervals.map(semitones =>
        new Tone.PitchShift({ pitch: semitones, windowSize: 0.025 })
      );
      harmonyGains = intervals.map(() => new Tone.Gain(0));

      const rawCtx = Tone.context.rawContext;
      const micSource = rawCtx.createMediaStreamSource(stream);
      const merger = rawCtx.createChannelMerger(2);

      micSource.connect(directGain);
      directGain.connect(mixerGain);
      harmonyShifts.forEach((shift, i) => {
        micSource.connect(shift);
        shift.connect(harmonyGains[i]);
        harmonyGains[i].connect(mixerGain);
      });
      mixerGain.connect(merger, 0, 0);
      mixerGain.connect(merger, 0, 1);
      const stereoNode = new Tone.Gain(1);
      merger.connect(stereoNode);
      stereoNode.connect(vocalTremolo);
      vocalTremolo.connect(vocalChorus);
      vocalChorus.connect(reverb);
      console.log('✅ Audio: Choir Mode | Mic → [Direct + 3 Harmonies] → Mixer → Chorus → Reverb');
    } catch (err) {
      console.error('❌ Microphone error — name:', err.name, 'message:', err.message);
      alert('Microphone error (' + err.name + '): ' + err.message + '\nPlease check browser permissions.');
      audioInitialized = false;
      return;
    }
  } else {
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: preset.oscillator,
      envelope:   preset.envelope,
    });
    synth.maxPolyphony = 6;

    if (preset.useChorus) {
      chorus = new Tone.Chorus({ frequency: 0.5, delayTime: 3.5, depth: 0.4, wet: 0.5 });
      chorus.start();
      synth.connect(chorus);
      chorus.connect(delay);
    } else {
      synth.connect(delay);
    }
    console.log('✅ Audio: ' + instrument + ' synth | Delay (time=' + delayTime + 's) → Reverb (decay=' + reverbDecay + 's, wet=' + reverbWet + ') → Output');
  }

  delay.connect(reverb);
  reverb.connect(masterGain);

  const rawCtx = Tone.getContext().rawContext;
  audioRecordDest = rawCtx.createMediaStreamDestination();
  masterGain.connect(audioRecordDest);
}

function playNote(freq) {
  if (!audioInitialized) return;
  synth.frequency.rampTo(freq, 0.05);
  if (synth.triggerAttack) synth.triggerAttack();
}

function stopNote() {
  if (!audioInitialized) return;
  if (synth.triggerRelease) synth.triggerRelease();
}

let lastRootFreq = 0;
let lastChordType = null;
let isChordPlaying = false;
let currentChordFreqs = [];
let currentChordNotesStr = '';
let handLostFrames = 0;
const HAND_LOST_DEBOUNCE = 12;
let audioPlayCount = 0;
let lastTriggerTime = 0;
let lastClampedIdx = 0;
const CHORD_STEP_THRESHOLD = 2;
const CHORD_TIME_DEBOUNCE_MS = 250;
let guideMap = [];
let activeNoteIdx = -1;
let fistActive = false;
let fistOpenFrames = 0;
const FIST_OPEN_DEBOUNCE = 20;
let detectedFistState = false;
let fistStateFrames = 0;
const FIST_STATE_DEBOUNCE = 5;
let chordSustainModeEnabled = false;
let vocalModeEnabled = false;
let vocalAxisX = 'reverb';
let vocalAxisY = 'harmonyBlend';
let vocalAxisFist = 'chorus';
let micInput = null;
let vocalChorus = null;
let vocalTremolo = null;
let harmonyShifts = [];
let harmonyGains = [];
let directGain = null;

let debugOnce = true;

function getChordType(pinchDist) {
  if (pinchDist < 0.25) return 'major';
  if (pinchDist < 0.50) return 'minor';
  if (pinchDist < 0.75) return 'sus2';
  return 'sus4';
}

function buildChord(rootIdx, chordType, scaleNotes) {
  return CHORD_SCALE_STEPS[chordType].map(steps => {
    const idx = Math.min(rootIdx + steps, scaleNotes.length - 1);
    return scaleNotes[idx];
  });
}

function buildExtendedScaleNotes(scale, multiplier = 1) {
  const { root, intervals } = scale;
  const notes = [];
  for (let octave = 0; octave <= 3; octave++) {
    for (const interval of intervals) {
      const semitones = octave * 12 + interval;
      notes.push(root * multiplier * Math.pow(2, semitones / 12));
    }
  }
  return notes;
}

function formatChordNotes(rootIdx, scaleNoteNames) {
  const steps = [0, 2, 4];
  return steps.map(step => {
    const idx = (rootIdx + step) % scaleNoteNames.length;
    return scaleNoteNames[idx];
  }).join(' + ');
}

function mapGestureToAudio(gesture) {
  if (!audioInitialized || !synth || currentNotes.length === 0) return;

  const idx = Math.floor((1 - gesture.palmY) * currentNotes.length);
  const clampedIdx = Math.max(0, Math.min(currentNotes.length - 1, idx));
  const rootFreq = currentNotes[clampedIdx];
  activeNoteIdx = clampedIdx;

  if (chordSustainModeEnabled) {
    // Chord sustain mode: any hand visible = always sustain chord, change immediately
    if (!fistActive) {
      const chordFreqs = buildChord(clampedIdx, 'major', extendedScaleNotes);
      synth.triggerAttack(chordFreqs);
      isChordPlaying = true;
      lastRootFreq = rootFreq;
      lastClampedIdx = clampedIdx;
      lastTriggerTime = performance.now();
      currentChordFreqs = chordFreqs;
      currentChordNotesStr = formatChordNotes(clampedIdx, SCALES[currentScale].noteNames);
      HUD.chord.textContent = currentChordNotesStr;
      lastChordType = 'major';
      fistActive = true;
      console.log('CHORD (sustain mode on):', chordFreqs.map(f => f.toFixed(1)));
    } else if (clampedIdx !== lastClampedIdx) {
      // Change chord immediately without debounce
      const chordFreqs = buildChord(clampedIdx, 'major', extendedScaleNotes);
      synth.triggerAttack(chordFreqs);
      lastRootFreq = rootFreq;
      lastClampedIdx = clampedIdx;
      lastTriggerTime = performance.now();
      currentChordFreqs = chordFreqs;
      currentChordNotesStr = formatChordNotes(clampedIdx, SCALES[currentScale].noteNames);
      HUD.chord.textContent = currentChordNotesStr;
      console.log('CHORD (sustain mode move):', chordFreqs.map(f => f.toFixed(1)));
    }
  } else {
    // Original fist-based mode
    const isFist = !gesture.isOpen;

    if (isFist) {
      fistOpenFrames = 0;
      if (!fistActive) {
        const chordFreqs = buildChord(clampedIdx, 'major', extendedScaleNotes);
        synth.triggerAttack(chordFreqs);
        isChordPlaying = true;
        lastRootFreq = rootFreq;
        lastClampedIdx = clampedIdx;
        lastTriggerTime = performance.now();
        currentChordFreqs = chordFreqs;
        currentChordNotesStr = formatChordNotes(clampedIdx, SCALES[currentScale].noteNames);
        HUD.chord.textContent = currentChordNotesStr;
        lastChordType = 'major';
        fistActive = true;
        console.log('CHORD (fist):', chordFreqs.map(f => f.toFixed(1)));
      } else {
        const stepDelta = Math.abs(clampedIdx - lastClampedIdx);
        const timeDelta = performance.now() - lastTriggerTime;
        if (stepDelta >= CHORD_STEP_THRESHOLD && timeDelta >= CHORD_TIME_DEBOUNCE_MS) {
          const chordFreqs = buildChord(clampedIdx, 'major', extendedScaleNotes);
          synth.triggerAttack(chordFreqs);
          lastRootFreq = rootFreq;
          lastClampedIdx = clampedIdx;
          lastTriggerTime = performance.now();
          currentChordFreqs = chordFreqs;
          currentChordNotesStr = formatChordNotes(clampedIdx, SCALES[currentScale].noteNames);
          HUD.chord.textContent = currentChordNotesStr;
          console.log('CHORD (fist move):', chordFreqs.map(f => f.toFixed(1)));
        }
      }
    } else {
      if (fistActive) {
        fistOpenFrames++;
        if (fistOpenFrames >= FIST_OPEN_DEBOUNCE) {
          stopChord();
          fistOpenFrames = 0;
        }
      } else {
        fistOpenFrames = 0;
      }
    }
  }
}

function stopChord() {
  if (isChordPlaying && audioInitialized && synth) {
    synth.releaseAll();
    isChordPlaying = false;
    lastRootFreq = 0;
    lastChordType = null;
    currentChordFreqs = [];
    currentChordNotesStr = '';
    HUD.chord.textContent = '-';
    activeNoteIdx = -1;
    fistActive = false;
    fistOpenFrames = 0;
  }
}

function applyVocalAxis(param, value) {
  if (!audioInitialized || param === 'none') return;
  switch (param) {
    case 'reverb':
      reverb.wet.value = value;
      break;
    case 'delayWet':
      delay.wet.value = value;
      break;
    case 'chorusWet':
      if (vocalChorus) vocalChorus.wet.value = value;
      break;
    case 'harmonyBlend':
      if (harmonyGains.length === 3) {
        harmonyGains[0].gain.value = Math.min(0.54, Math.max(0, value * 0.54));
        harmonyGains[1].gain.value = Math.min(0.9, Math.max(0, value * 0.9));
        harmonyGains[2].gain.value = Math.min(0.36, Math.max(0, (value - 0.3) * 0.514));
      }
      break;
    case 'directBlend':
      if (directGain) directGain.gain.value = value * 0.9;
      break;
  }
}

function applyVocalFist(param, isOpen) {
  if (!audioInitialized || param === 'none') return;
  switch (param) {
    case 'chorus':
      if (vocalChorus) vocalChorus.wet.value = isOpen ? 1 : 0;
      break;
    case 'tremolo':
      if (vocalTremolo) vocalTremolo.wet.value = isOpen ? 0.8 : 0;
      break;
    case 'harmony':
      if (harmonyGains.length === 3) {
        harmonyGains.forEach(g => {
          g.gain.value = isOpen ? (g._savedGain ?? 0.5) : 0;
        });
      }
      break;
    case 'reverb':
      reverb.wet.value = isOpen ? 1 : 0;
      break;
  }
}

function mapGestureToVocal(gesture) {
  if (!audioInitialized || !vocalChorus) return;

  const x = gesture.palmX;
  const y = 1 - gesture.palmY;

  applyVocalAxis(vocalAxisX, x);
  applyVocalAxis(vocalAxisY, y);
  applyVocalFist(vocalAxisFist, gesture.isOpen);

  const numActive = harmonyGains.filter(g => g.gain.value > 0.1).length;
  HUD.chord.textContent = ['SOLO', '2-VOICE', 'FULL CHOIR'][numActive];

  let freqLabel = '';
  switch (vocalAxisX) {
    case 'reverb': freqLabel = Math.round(x * 100) + '% reverb'; break;
    case 'delayWet': freqLabel = Math.round(x * 100) + '% delay'; break;
    case 'chorusWet': freqLabel = Math.round(x * 100) + '% chorus'; break;
    case 'directBlend': freqLabel = Math.round(x * 100) + '% direct'; break;
    case 'harmonyBlend': freqLabel = Math.round(x * 100) + '% harmony'; break;
  }
  HUD.freq.textContent = freqLabel;

  let noteLabel = '';
  switch (vocalAxisFist) {
    case 'chorus': noteLabel = gesture.isOpen ? 'CHORUS ON' : 'CHORUS OFF'; break;
    case 'tremolo': noteLabel = gesture.isOpen ? 'TREMOLO ON' : 'TREMOLO OFF'; break;
    case 'harmony': noteLabel = gesture.isOpen ? 'HARMONY ON' : 'HARMONY OFF'; break;
    case 'reverb': noteLabel = gesture.isOpen ? 'REVERB ON' : 'REVERB OFF'; break;
  }
  HUD.note.textContent = noteLabel;
}

startBtn.addEventListener('click', async () => {
  const scaleSelect = document.getElementById('scaleSelect');
  currentScale = scaleSelect.value;
  const octaveOffset = parseInt(document.getElementById('octaveSelect').value);
  const octaveMultiplier = Math.pow(2, octaveOffset);
  chordSustainModeEnabled = document.getElementById('chordSustainMode').checked;
  vocalModeEnabled = document.getElementById('vocalMode').checked;
  currentNotes = buildScaleNotes(SCALES[currentScale], octaveMultiplier);
  extendedScaleNotes = buildExtendedScaleNotes(SCALES[currentScale], octaveMultiplier);
  console.log('Scale selected:', currentScale, 'Octave:', octaveOffset, 'Sustain mode:', chordSustainModeEnabled, 'Vocal mode:', vocalModeEnabled, '- Notes:', currentNotes.length);

  const scaleNoteNames = SCALES[currentScale].noteNames;
  guideMap = currentNotes.map((freq, i) => {
    const noteName = scaleNoteNames[i % scaleNoteNames.length];
    const chordFreqs = buildChord(i, 'major', extendedScaleNotes);
    const semitones = Math.round(12 * Math.log2(chordFreqs[1] / freq));
    const quality = semitones === 4 ? 'MAJ' : semitones === 3 ? 'MIN' : 'DIM';
    return { label: noteName + ' ' + quality };
  });

  const reverbDecay = parseFloat(document.getElementById('reverbDecay').value);
  const reverbWet = parseFloat(document.getElementById('reverbWet').value);
  const delayTime = parseFloat(document.getElementById('delayTime').value);
  const delayFeedback = parseFloat(document.getElementById('delayFeedback').value);
  const delayWet = parseFloat(document.getElementById('delayWet').value);
  const instrument = document.getElementById('instrumentSelect').value;

  await initAudio(reverbDecay, reverbWet, delayTime, delayFeedback, delayWet, instrument);
  splash.classList.add('hidden');
  if (vocalModeEnabled) {
    document.getElementById('vocalPanel').style.display = 'block';
  }
  document.getElementById('recBtn').style.display = 'block';
});

['vocalAxisX', 'vocalAxisY', 'vocalAxisFist'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('change', function() {
      if (id === 'vocalAxisX') vocalAxisX = this.value;
      else if (id === 'vocalAxisY') vocalAxisY = this.value;
      else vocalAxisFist = this.value;
    });
  }
});

function startRecording() {
  recordingChunks = [];
  const canvasStream = canvas.captureStream(30);
  audioRecordDest.stream.getAudioTracks().forEach(t => canvasStream.addTrack(t));

  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(canvasStream, { mimeType });
  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) recordingChunks.push(e.data); };
  mediaRecorder.onstop = () => {
    const blob = new Blob(recordingChunks, { type: 'video/webm' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'airloom-' + new Date().toISOString().slice(0,19).replace(/[:T]/g,'-') + '.webm';
    a.click();
    URL.revokeObjectURL(url);
  };
  mediaRecorder.start();
  isRecording = true;
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  isRecording = false;
}

const recBtn = document.getElementById('recBtn');
recBtn.addEventListener('click', () => {
  if (!isRecording) {
    startRecording();
    recBtn.textContent = '■ STOP';
    recBtn.classList.add('recording');
  } else {
    stopRecording();
    recBtn.textContent = '● REC';
    recBtn.classList.remove('recording');
  }
});

initCamera();

const gestureState = {
  palmX: 0,
  palmY: 0,
  isOpen: false,
  pinchDist: 0,
  handSpeed: 0,
  prevPalmX: 0,
  prevPalmY: 0,
};

function lerp(a, b, t) {
  return a + (b - a) * Math.max(0, Math.min(1, t));
}

function normalizeCoords(x, y) {
  const nx = Math.max(0, Math.min(1, x));
  const ny = Math.max(0, Math.min(1, y));
  return [nx, ny];
}

function getFrequencyFromNote(noteIndex) {
  const A4 = 440;
  return A4 * Math.pow(2, (noteIndex - 48) / 12);
}

function getNoteFromFrequency(freq) {
  const A4 = 440;
  const noteIndex = Math.round(12 * Math.log2(freq / A4) + 48);
  const notes = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const octave = Math.floor((noteIndex - 12) / 12);
  const noteName = notes[(noteIndex) % 12];
  return `${noteName}${octave}`;
}

function extractGestureState(landmarks) {
  if (!landmarks || landmarks.length < 17) {
    HUD.detected.textContent = 'No';
    return null;
  }

  const rightWrist = landmarks[16];
  const rightElbow = landmarks[14];
  const rightShoulder = landmarks[12];

  const palmX = rightWrist.x;
  const palmY = rightWrist.y;
  const [nx, ny] = normalizeCoords(palmX, palmY);

  const elbowVec = {
    x: rightElbow.x - rightWrist.x,
    y: rightElbow.y - rightWrist.y,
  };
  const elbowDist = Math.sqrt(elbowVec.x ** 2 + elbowVec.y ** 2);
  const armLength = Math.sqrt(
    (rightShoulder.x - rightWrist.x) ** 2 +
    (rightShoulder.y - rightWrist.y) ** 2
  );

  const isOpen = elbowDist > armLength * 0.3;

  const dx = nx - gestureState.prevPalmX;
  const dy = ny - gestureState.prevPalmY;
  const delta = Math.sqrt(dx ** 2 + dy ** 2);
  const speed = Math.max(0, Math.min(1, delta * 5));

  gestureState.prevPalmX = nx;
  gestureState.prevPalmY = ny;
  gestureState.palmX = nx;
  gestureState.palmY = ny;
  gestureState.isOpen = isOpen;
  gestureState.pinchDist = Math.max(0, Math.min(1, elbowDist / armLength));
  gestureState.handSpeed = speed * 0.5 + gestureState.handSpeed * 0.5;

  HUD.detected.textContent = 'Yes';
  HUD.palmX.textContent = nx.toFixed(2);
  HUD.palmY.textContent = ny.toFixed(2);
  HUD.open.textContent = isOpen ? 'Arm Out' : 'Arm In';
  HUD.pinch.textContent = gestureState.pinchDist.toFixed(2);
  HUD.speed.textContent = gestureState.handSpeed.toFixed(2);

  return gestureState;
}

function drawTitle() {
  ctx.save();
  ctx.scale(-1, 1);
  ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Airloom', -canvas.width / 2, 60);
  ctx.restore();
}

function drawChordLabel(chordType, notesStr) {
  if (!chordType || !notesStr) return;
  const x = canvas.width / 2;
  const y = canvas.height - 75;

  ctx.fillStyle = 'rgba(0, 0, 0, 0.65)';
  ctx.beginPath();
  ctx.roundRect(x - 180, y - 45, 360, 70, 10);
  ctx.fill();

  ctx.save();
  ctx.scale(-1, 1);

  ctx.fillStyle = '#00ff00';
  ctx.font = 'bold 28px Courier New, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(chordType.toUpperCase(), -x, y - 8);

  ctx.font = '18px Courier New, monospace';
  ctx.fillStyle = 'rgba(0, 255, 0, 0.8)';
  ctx.fillText(notesStr, -x, y + 22);

  ctx.restore();
}

function drawGuideMap(activeIdx) {
  if (vocalModeEnabled) {
    drawVocalInstructions();
    return;
  }

  if (!guideMap.length) return;
  const n = guideMap.length;
  const bandH = canvas.height / n;

  ctx.save();
  ctx.scale(-1, 1);

  for (let i = 0; i < n; i++) {
    const y = canvas.height - (i + 1) * bandH;
    const isActive = (i === activeIdx);

    ctx.fillStyle = isActive
      ? 'rgba(0, 255, 0, 0.15)'
      : (i % 2 === 0 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0)');
    ctx.fillRect(-canvas.width, y, canvas.width, bandH);

    ctx.fillStyle = isActive ? '#00ff00' : 'rgba(0,255,0,0.7)';
    ctx.font = isActive ? 'bold 18px Courier New' : 'bold 16px Courier New';
    ctx.textAlign = 'left';
    ctx.fillText(guideMap[i].label, -(canvas.width - 12), y + bandH * 0.65);

    ctx.strokeStyle = 'rgba(0,255,0,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(-canvas.width, y + bandH);
    ctx.lineTo(0, y + bandH);
    ctx.stroke();
  }

  ctx.restore();
}

function drawVocalInstructions() {
  ctx.save();
  ctx.scale(-1, 1);

  ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
  ctx.fillRect(-canvas.width, 0, canvas.width, canvas.height);

  ctx.fillStyle = '#00ff00';
  ctx.font = 'bold 24px Courier New, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('VOCAL MODE', -canvas.width / 2, canvas.height / 2 - 100);

  ctx.font = '18px Courier New, monospace';
  ctx.fillStyle = 'rgba(0, 255, 0, 0.9)';

  const AXIS_LABEL = { none:'OFF', reverb:'REVERB', delayWet:'DELAY', chorusWet:'CHORUS WET', harmonyBlend:'HARMONY', directBlend:'DIRECT' };
  const FIST_LABEL = { none:'OFF', chorus:'CHORUS', tremolo:'TREMOLO', harmony:'HARMONY', reverb:'REVERB' };

  const instructions = [
    `← LEFT / → RIGHT = ${AXIS_LABEL[vocalAxisX] ?? vocalAxisX.toUpperCase()}`,
    `↑ UP / ↓ DOWN = ${AXIS_LABEL[vocalAxisY] ?? vocalAxisY.toUpperCase()}`,
    `✦ OPEN = ${FIST_LABEL[vocalAxisFist] ?? vocalAxisFist.toUpperCase()} ON  |  FIST = OFF`,
  ];
  const lineHeight = 40;
  instructions.forEach((text, i) => {
    ctx.fillText(text, -canvas.width / 2, canvas.height / 2 - 20 + i * lineHeight);
  });

  ctx.restore();
}

let colorReady = false;
let targetColor = 'red';
let prevCentroidX = 0;
let prevCentroidY = 0;

function initHandDetection() {
  console.log('Initializing color-based hand tracking...');
  console.log('Wearing bright red gloves/paint for best detection');
  colorReady = true;
  console.log('✅ Color-based hand detection ready!');
  detectHands();
}

function detectColorHand() {
  if (!colorReady || !cameraActive) {
    requestAnimationFrame(detectColorHand);
    return;
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  let sumX = 0, sumY = 0, count = 0;
  let minX = canvas.width, maxX = 0, minY = canvas.height, maxY = 0;

  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const isColoredPixel = (r > 180 && g < 80 && b < 80 && r > g * 2.5 && r > b * 2.5);

    if (isColoredPixel) {
      const pixelIndex = i / 4;
      const x = pixelIndex % canvas.width;
      const y = Math.floor(pixelIndex / canvas.width);

      sumX += x;
      sumY += y;
      count++;

      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }

  ctx.save();
  ctx.scale(-1, 1);
  ctx.fillStyle = 'lime';
  ctx.font = 'bold 20px Arial';
  ctx.textAlign = 'right';
  ctx.fillText('Red pixels: ' + count, -20, 40);
  ctx.restore();

  if (count >= 80) {
    const centerX = sumX / count;
    const centerY = sumY / count;
    const bboxW = maxX - minX;
    const bboxH = maxY - minY;

    if (bboxW >= 60 && bboxH >= 60) {
      const density = count / (bboxW * bboxH);
      if (density >= 0.04) {
        const pinchDistRaw = bboxW / bboxH;
        const pinchDist = Math.max(0, Math.min(1, pinchDistRaw / 3));
        const bboxFraction = (bboxW * bboxH) / (canvas.width * canvas.height);
        const isOpen = bboxFraction > 0.08;

        const dx = centerX - prevCentroidX;
        const dy = centerY - prevCentroidY;
        const speed = Math.min(1, Math.sqrt(dx * dx + dy * dy) / 20);
        prevCentroidX = centerX;
        prevCentroidY = centerY;

        const palmX = centerX / canvas.width;
        const palmY = centerY / canvas.height;

        const gesture = {
          palmX: Math.max(0, Math.min(1, palmX)),
          palmY: Math.max(0, Math.min(1, palmY)),
          isOpen,
          pinchDist,
          handSpeed: speed,
          density,
        };

        drawHandSkeleton(centerX, centerY, bboxW, bboxH, isOpen);

        if (vocalModeEnabled) {
          drawFistIndicator(centerX, centerY, bboxH, isOpen);
        }

        if (audioInitialized) {
          if (vocalModeEnabled) {
            mapGestureToVocal(gesture);
          } else {
            mapGestureToAudio(gesture);
          }
        }

        HUD.open.textContent = isOpen ? 'Open' : 'Closed';
        HUD.pinch.textContent = pinchDist.toFixed(2);
        HUD.speed.textContent = speed.toFixed(2);

        handLostFrames = 0;
      }
    }
  } else {
    handLostFrames++;
    if (handLostFrames >= HAND_LOST_DEBOUNCE && audioInitialized) {
      stopChord();
      handLostFrames = 0;
    }
  }

  drawGuideMap(activeNoteIdx);
  drawChordLabel(lastChordType, currentChordNotesStr);
  drawTitle();
  requestAnimationFrame(detectColorHand);
}

function drawHandSkeleton(centerX, centerY, bboxW, bboxH, isOpen) {
  const palmRadius = Math.min(bboxW, bboxH) * 0.3;
  const fingerLen = Math.max(bboxW, bboxH) * 0.4;

  ctx.strokeStyle = isOpen ? '#00ff00' : '#ff8800';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(centerX, centerY, palmRadius, 0, Math.PI * 2);
  ctx.stroke();

  if (isOpen) {
    const fingerAngles = [-60, -30, 0, 30, 60].map(d => (d * Math.PI) / 180 - Math.PI / 2);
    ctx.strokeStyle = '#00ff00';
    ctx.lineWidth = 2;
    fingerAngles.forEach(angle => {
      ctx.beginPath();
      ctx.moveTo(centerX, centerY);
      ctx.lineTo(centerX + Math.cos(angle) * fingerLen, centerY + Math.sin(angle) * fingerLen);
      ctx.stroke();
    });
  }

  ctx.strokeStyle = isOpen ? '#00ff00' : '#ff8800';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(centerX, centerY + palmRadius);
  ctx.lineTo(centerX, centerY + bboxH * 0.5);
  ctx.stroke();
}

function drawFistIndicator(centerX, centerY, bboxH, isOpen) {
  ctx.save();
  ctx.scale(-1, 1);

  const labelY = centerY + bboxH * 0.6;
  const FIST_LABEL = { none:'OFF', chorus:'CHORUS', tremolo:'TREMOLO', harmony:'HARMONY', reverb:'REVERB' };
  const label = FIST_LABEL[vocalAxisFist] ?? vocalAxisFist.toUpperCase();
  const text = vocalAxisFist === 'none' ? 'OFF' : (isOpen ? label + ' ON' : label + ' OFF');
  const color = isOpen ? '#00ff00' : '#ff8800';

  ctx.fillStyle = color;
  ctx.font = 'bold 16px Courier New, monospace';
  ctx.textAlign = 'center';
  ctx.fillText(text, -centerX, labelY);

  ctx.restore();
}

const detectHands = detectColorHand;

console.log('Enabling mouse control fallback...');

let mouseX = 0.5;
let mouseY = 0.5;
let isMouseDown = false;
let prevMouseX = 0.5;
let prevMouseY = 0.5;
let mouseSpeed = 0;

document.addEventListener('mousemove', (e) => {
  prevMouseX = mouseX;
  prevMouseY = mouseY;
  mouseX = e.clientX / window.innerWidth;
  mouseY = e.clientY / window.innerHeight;
  const dx = mouseX - prevMouseX;
  const dy = mouseY - prevMouseY;
  mouseSpeed = Math.sqrt(dx * dx + dy * dy) * 0.3;
});

document.addEventListener('mousedown', () => {
  isMouseDown = true;
});

document.addEventListener('mouseup', () => {
  isMouseDown = false;
});

let frameCount = 0;

function updateFromMouse() {
  const gesture = {
    palmX: mouseX,
    palmY: mouseY,
    isOpen: isMouseDown,
    pinchDist: mouseSpeed,
    handSpeed: mouseSpeed,
  };

  if (audioInitialized) {
    mapGestureToAudio(gesture);
  }

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  ctx.save();
  ctx.scale(-1, 1);
  ctx.fillStyle = 'lime';
  ctx.font = 'bold 32px Arial';
  ctx.textAlign = 'left';
  ctx.fillText(isMouseDown ? '🔊 PLAYING' : '○ Ready', -20, 50);

  if (currentNotes.length > 0) {
    const idx = Math.floor((1 - mouseY) * currentNotes.length);
    const clampedIdx = Math.max(0, Math.min(currentNotes.length - 1, idx));
    const chordType = getChordType(mouseSpeed);
    ctx.fillText(getNoteFromFrequency(currentNotes[clampedIdx]) + ' ' + chordType + ' (' + currentChordNotesStr + ') — ' + currentScale, -20, 100);
  }
  ctx.restore();

  drawTitle();
  requestAnimationFrame(updateFromMouse);
}

console.log('Airloom initialized - hand detection or mouse control will start...');
