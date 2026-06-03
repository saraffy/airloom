// ============================================================================
// chordMap.ts -- on-screen vertical chord ladder.
// ----------------------------------------------------------------------------
// Renders a slim, semi-transparent overlay on the right edge of the stage:
//
//   ┌──────────────┐
//   │              │ ← midiHigh
//   │           C6 │
//   │           Am │
//   │           G  │  (active, highlighted, suffix opacity = density)
//   │  ▶ raw     F │
//   │           Em │
//   │           D  │
//   │           C4 │
//   │              │ ← midiLow
//   └──────────────┘
//
//   - Each rung = one scale step inside the pitch range (midiLow..midiHigh).
//   - Label = root note + chord-quality suffix (e.g. "Am", "F#°", "G").
//   - The rung at the right-hand SNAPPED MIDI is highlighted (mint).
//   - A small mint bar = exact raw (unsnapped) hand y, between rungs.
//   - On the active rung the suffix opacity = density: fist (0) shows just
//     the root letter, open palm (1) shows the full chord name.
//
// All purely visual; no audio paths are touched. Updates happen each rAF
// tick driven by main.ts.
// ============================================================================

import { chordFromScale, NOTE_NAMES } from './audio/scales';

interface Rung {
  midi: number;
  rootName: string;
  qualitySuffix: string;
}

interface RungElements {
  rung: HTMLDivElement;
  suffix: HTMLSpanElement;
}

/**
 * Map a triad's third-and-fifth intervals (semitones from root) onto a
 * chord-quality suffix. The seven scales we ship cover the standard
 * pop/jazz triads; pentatonic-style intervals fall through to '*'.
 */
function qualitySuffix(thirdInterval: number, fifthInterval: number): string {
  if (thirdInterval === 4 && fifthInterval === 7) return '';      // major
  if (thirdInterval === 3 && fifthInterval === 7) return 'm';     // minor
  if (thirdInterval === 3 && fifthInterval === 6) return '°';     // diminished
  if (thirdInterval === 4 && fifthInterval === 8) return '+';     // augmented
  if (thirdInterval === 5 && fifthInterval === 7) return 'sus4';
  if (thirdInterval === 2 && fifthInterval === 7) return 'sus2';
  return '*';
}

function buildLadder(
  midiLow: number,
  midiHigh: number,
  scale: readonly number[],
  scaleRoot: number,
): Rung[] {
  const rungs: Rung[] = [];
  for (let m = midiLow; m <= midiHigh; m++) {
    // Only include MIDI values that ARE scale degrees in the current key.
    const semitone = m - scaleRoot;
    const pc = ((semitone % 12) + 12) % 12;
    if (scale.indexOf(pc) < 0) continue;

    const triad = chordFromScale(m, 3, scale, scaleRoot);
    const thirdInterval = ((triad[1]! - triad[0]!) % 12 + 12) % 12;
    const fifthInterval = ((triad[2]! - triad[0]!) % 12 + 12) % 12;
    const rootPc = ((triad[0]! % 12) + 12) % 12;

    rungs.push({
      midi: m,
      rootName: NOTE_NAMES[rootPc]!,
      qualitySuffix: qualitySuffix(thirdInterval, fifthInterval),
    });
  }
  return rungs;
}

export interface ChordMapUpdate {
  /** Snapped MIDI of the currently-played chord (= active rung). null hides. */
  snappedMidi: number | null;
  /** Continuous (unsnapped) MIDI for the marker. null hides the marker. */
  rawMidi: number | null;
  /** Left-hand-density in [0, 1]; controls the active rung's suffix opacity. */
  density: number;
  /**
   * Whether any audio is currently audible (robot or clean monitor). When
   * false the highlight goes away; the rungs stay visible so the user can
   * still see the scale.
   */
  audible: boolean;
}

export class ChordMap {
  private readonly root: HTMLDivElement;
  private readonly rungLayer: HTMLDivElement;
  private readonly marker: HTMLDivElement;
  private readonly rungs: Map<number, RungElements> = new Map();
  /** Raw ladder data, kept so drawToCanvas() doesn't have to re-parse the DOM. */
  private ladder: Rung[] = [];
  private midiLow = 0;
  private midiHigh = 0;
  private activeMidi: number | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div');
    this.root.className = 'chord-map';

    this.rungLayer = document.createElement('div');
    this.rungLayer.className = 'chord-map-rungs';
    this.root.appendChild(this.rungLayer);

    this.marker = document.createElement('div');
    this.marker.className = 'chord-map-marker hidden';
    this.root.appendChild(this.marker);

    parent.appendChild(this.root);
  }

  /**
   * (Re)build the ladder for a new pitch range or new key/scale. Called on
   * startup and from the scale/key dropdown handlers in main.ts.
   */
  rebuild(
    midiLow: number,
    midiHigh: number,
    scale: readonly number[],
    scaleRoot: number,
  ): void {
    this.midiLow = midiLow;
    this.midiHigh = midiHigh;
    this.rungs.clear();
    this.rungLayer.replaceChildren();
    this.activeMidi = null;

    this.ladder = buildLadder(midiLow, midiHigh, scale, scaleRoot);
    for (const r of this.ladder) {
      const rungEl = document.createElement('div');
      rungEl.className = 'chord-map-rung';
      rungEl.style.top = `${this.midiToYPercent(r.midi).toFixed(2)}%`;

      // Visual: tick mark + root letter + (optional) quality suffix.
      const tick = document.createElement('span');
      tick.className = 'rung-tick';
      rungEl.appendChild(tick);

      const rootSpan = document.createElement('span');
      rootSpan.className = 'rung-root';
      rootSpan.textContent = r.rootName;
      rungEl.appendChild(rootSpan);

      const suffixSpan = document.createElement('span');
      suffixSpan.className = 'rung-suffix';
      suffixSpan.textContent = r.qualitySuffix;
      rungEl.appendChild(suffixSpan);

      this.rungLayer.appendChild(rungEl);
      this.rungs.set(r.midi, { rung: rungEl, suffix: suffixSpan });
    }
  }

  /** Called every rAF tick from main.ts. Cheap -- only mutates classes/styles. */
  update(u: ChordMapUpdate): void {
    // Active rung
    const newActive = u.audible ? u.snappedMidi : null;
    if (newActive !== this.activeMidi) {
      if (this.activeMidi !== null) {
        const prev = this.rungs.get(this.activeMidi);
        if (prev) {
          prev.rung.classList.remove('active');
          // Reset inline opacity so the CSS default (visible) applies again.
          prev.suffix.style.opacity = '';
        }
      }
      if (newActive !== null) {
        const cur = this.rungs.get(newActive);
        if (cur) cur.rung.classList.add('active');
      }
      this.activeMidi = newActive;
    }
    // Density-driven suffix opacity on the active rung. Fist = 0 (just root
    // letter); open palm = 1 (full chord name with quality suffix).
    if (this.activeMidi !== null) {
      const cur = this.rungs.get(this.activeMidi);
      if (cur) cur.suffix.style.opacity = u.density.toFixed(2);
    }

    // Hand marker
    if (u.rawMidi !== null) {
      this.marker.style.top = `${this.midiToYPercent(u.rawMidi).toFixed(2)}%`;
      this.marker.classList.remove('hidden');
    } else {
      this.marker.classList.add('hidden');
    }
  }

  /**
   * Map a MIDI value into a percentage from the TOP of the container.
   * Compressed slightly (5%..95%) so the topmost and bottommost rungs
   * don't get visually clipped by the container's overflow.
   */
  private midiToYPercent(midi: number): number {
    const clamped = Math.max(this.midiLow, Math.min(this.midiHigh, midi));
    const t = (clamped - this.midiLow) / (this.midiHigh - this.midiLow || 1);
    // t = 0 at midiLow (bottom), t = 1 at midiHigh (top)
    return 5 + (1 - t) * 90;
  }

  /**
   * Mirror the chord map state onto a 2D canvas context. The DOM overlay
   * isn't seen by canvas.captureStream() -- this draw makes the chord map
   * appear in recordings. Visually, the DOM overlay sits on top of the
   * canvas, so live viewers still see the styled HTML version.
   *
   * Layout is the same as the DOM version: a slim panel against the
   * RIGHT edge of the canvas with one rung per scale note, active rung
   * highlighted in mint, marker as a horizontal bar.
   */
  drawToCanvas(ctx: CanvasRenderingContext2D, state: ChordMapUpdate): void {
    if (this.ladder.length === 0 || this.midiHigh <= this.midiLow) return;
    const w = ctx.canvas.width;
    const h = ctx.canvas.height;

    // Panel sized as a fraction of canvas width so it scales with the
    // (camera-driven) canvas size. ~13% matches the 92px DOM width at
    // a typical 720px-wide stage.
    const panelW = Math.round(w * 0.13);
    const panelX = w - panelW;

    // Background gradient: matches the DOM CSS gradient closely enough
    // that the recording feels like a screenshot of the live UI.
    const grad = ctx.createLinearGradient(panelX, 0, w, 0);
    grad.addColorStop(0, 'rgba(8, 10, 14, 0)');
    grad.addColorStop(0.3, 'rgba(8, 10, 14, 0.45)');
    grad.addColorStop(1, 'rgba(8, 10, 14, 0.65)');
    ctx.fillStyle = grad;
    ctx.fillRect(panelX, 0, panelW, h);

    const midiToCanvasY = (midi: number): number => {
      const yPct = this.midiToYPercent(midi);
      return (yPct / 100) * h;
    };

    const baseFontPx = Math.max(10, Math.round(h * 0.025));
    const activeFontPx = Math.max(13, Math.round(h * 0.032));
    const accent = '#5ee0a4';
    const dim = 'rgba(230, 234, 240, 0.45)';
    const tickDim = 'rgba(230, 234, 240, 0.3)';

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    for (const rung of this.ladder) {
      const isActive = state.audible && state.snappedMidi === rung.midi;
      const y = midiToCanvasY(rung.midi);

      // Tick mark on the right edge.
      const tickW = isActive ? 18 : 10;
      const tickH = isActive ? 2 : 1;
      ctx.fillStyle = isActive ? accent : tickDim;
      ctx.fillRect(w - tickW - 4, y - tickH / 2, tickW, tickH);

      // Label = root + (optional) quality suffix.
      const labelRightX = w - tickW - 8;
      if (isActive) {
        ctx.font = `700 ${activeFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = accent;
        // Draw suffix flush-right with opacity = density, then root left of it.
        const suffix = rung.qualitySuffix;
        const suffixW = suffix ? ctx.measureText(suffix).width : 0;
        if (suffix) {
          ctx.globalAlpha = Math.max(0, Math.min(1, state.density));
          ctx.fillText(suffix, labelRightX, y);
          ctx.globalAlpha = 1;
        }
        ctx.fillText(rung.rootName, labelRightX - suffixW, y);
      } else {
        ctx.font = `${baseFontPx}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.fillStyle = dim;
        ctx.fillText(rung.rootName + rung.qualitySuffix, labelRightX, y);
      }
    }

    // Hand marker: short horizontal bar at the un-snapped pitch.
    if (state.rawMidi !== null) {
      const y = midiToCanvasY(state.rawMidi);
      ctx.fillStyle = 'rgba(94, 224, 164, 0.7)';
      ctx.fillRect(w - 30, y - 1, 30, 2);
    }
  }
}
