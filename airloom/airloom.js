const video = document.getElementById('video');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const splash = document.getElementById('splash');
const startBtn = document.getElementById('startBtn');

let audioInitialized = false;
let cameraActive = false;

let synth = null;
let pad = null;
let masterGain = null;
let filter = null;
let distortion = null;
let vibrato = null;

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
};

async function initCamera() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });
    video.srcObject = stream;
    video.addEventListener('loadedmetadata', () => {
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      cameraActive = true;
    });
  } catch (err) {
    console.error('Camera access denied:', err);
  }
}

function initAudio() {
  if (audioInitialized) return;
  audioInitialized = true;

  Tone.start();

  masterGain = new Tone.Gain(0.6).toDestination();

  pad = new Tone.PolySynth(Tone.Synth, {
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.4, decay: 0.2, sustain: 0.8, release: 1.5 },
  }).connect(masterGain);

  synth = new Tone.Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.1, release: 0.5 },
  });

  vibrato = new Tone.Vibrato({
    frequency: 5,
    depth: 0.2,
  });

  distortion = new Tone.Distortion(0).connect(vibrato);
  filter = new Tone.Filter({
    frequency: 3000,
    type: 'lowpass',
  }).connect(distortion);

  synth.connect(filter);
  vibrato.connect(masterGain);

  pad.triggerAttackRelease('A3', '1n');

  console.log('AudioContext initialized with synth and pad');
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

function mapGestureToAudio(gesture) {
  if (!audioInitialized) return;

  const freq = lerp(880, 110, gesture.palmY);
  synth.frequency.rampTo(freq, 0.05);

  const filterFreq = lerp(200, 8000, gesture.palmX);
  filter.frequency.rampTo(filterFreq, 0.05);

  const gain = gesture.isOpen ? 0.8 : 0;
  masterGain.gain.rampTo(gain, 0.1);

  const vibDepth = gesture.pinchDist * 12;
  vibrato.depth.rampTo(vibDepth, 0.05);

  const distAmount = gesture.handSpeed * 0.8;
  distortion.distortion = distAmount;

  HUD.freq.textContent = freq.toFixed(0);
  HUD.note.textContent = getNoteFromFrequency(freq);
}

startBtn.addEventListener('click', () => {
  initAudio();
  splash.classList.add('hidden');
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
  if (!landmarks || landmarks.length === 0) {
    HUD.detected.textContent = 'No';
    return null;
  }

  const wrist = landmarks[0];
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const thumbMCP = landmarks[2];
  const indexMCP = landmarks[5];
  const middleMCP = landmarks[9];
  const ringMCP = landmarks[13];
  const pinkyMCP = landmarks[17];

  const palmX = wrist.x;
  const palmY = wrist.y;
  const [nx, ny] = normalizeCoords(palmX, palmY);

  const pinchVec = {
    x: indexTip.x - thumbTip.x,
    y: indexTip.y - thumbTip.y,
  };
  const pinchDist = Math.sqrt(pinchVec.x ** 2 + pinchVec.y ** 2);

  const thumbExtended = thumbTip.y < thumbMCP.y;
  const indexExtended = indexTip.y < indexMCP.y;
  const middleExtended = landmarks[12].y < middleMCP.y;
  const ringExtended = landmarks[16].y < ringMCP.y;
  const pinkyExtended = landmarks[20].y < pinkyMCP.y;

  const extendedCount = [thumbExtended, indexExtended, middleExtended, ringExtended, pinkyExtended].filter(Boolean).length;
  const isOpen = extendedCount >= 4;

  const dx = nx - gestureState.prevPalmX;
  const dy = ny - gestureState.prevPalmY;
  const delta = Math.sqrt(dx ** 2 + dy ** 2);
  const speed = Math.max(0, Math.min(1, delta * 5));

  gestureState.prevPalmX = nx;
  gestureState.prevPalmY = ny;
  gestureState.palmX = nx;
  gestureState.palmY = ny;
  gestureState.isOpen = isOpen;
  gestureState.pinchDist = Math.max(0, Math.min(1, pinchDist * 3));
  gestureState.handSpeed = speed * 0.5 + gestureState.handSpeed * 0.5;

  HUD.detected.textContent = 'Yes';
  HUD.palmX.textContent = nx.toFixed(2);
  HUD.palmY.textContent = ny.toFixed(2);
  HUD.open.textContent = isOpen ? 'Open' : 'Closed';
  HUD.pinch.textContent = gestureState.pinchDist.toFixed(2);
  HUD.speed.textContent = gestureState.handSpeed.toFixed(2);

  return gestureState;
}

function drawTitle() {
  ctx.fillStyle = 'rgba(0, 255, 0, 0.3)';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Airloom', canvas.width / 2, 60);
}

const hands = new Hands({
  locateFile: (file) => {
    return `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`;
  },
});

hands.setOptions({
  maxNumHands: 1,
  modelComplexity: 1,
  minDetectionConfidence: 0.7,
  minTrackingConfidence: 0.5,
});

hands.onResults((results) => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let p of particles) {
    p.update();
    p.draw(ctx);
  }
  particles.forEach((p, i) => {
    if (p.life <= 0) particles.splice(i, 1);
  });

  if (results.landmarks && results.landmarks.length > 0) {
    const landmarks = results.landmarks[0];
    drawingUtils.drawConnectors(ctx, landmarks, Hands.HAND_CONNECTIONS, {
      color: '#00ff00',
      lineWidth: 2,
    });

    const gesture = extractGestureState(landmarks);

    const landmarkColor = gesture && gesture.isOpen ? '#00ff00' : '#ff3333';
    drawingUtils.drawLandmarks(ctx, landmarks, {
      color: landmarkColor,
      lineWidth: 1,
      radius: 3,
    });

    if (gesture && audioInitialized) {
      const palmScreenX = landmarks[0].x * canvas.width;
      const palmScreenY = landmarks[0].y * canvas.height;
      const freq = lerp(880, 110, gesture.palmY);
      spawnParticle(palmScreenX, palmScreenY, freq);

      mapGestureToAudio(gesture);
    }
  }

  drawTitle();
});

const camera = new Camera(video, {
  onFrame: async () => {
    if (cameraActive) {
      await hands.send({ image: video });
    }
  },
  width: 1280,
  height: 720,
});

camera.start();

console.log('Phase 1: Scaffold + Camera Feed initialized');
