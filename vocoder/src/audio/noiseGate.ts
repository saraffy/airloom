// ============================================================================
// noiseGate.ts
// ----------------------------------------------------------------------------
// Thin TypeScript wrapper around the noise-gate AudioWorkletProcessor.
// Hysteresis-aware: openDb opens the gate, closeDb must be undershot for
// `holdSec` before the gate begins releasing.
// ============================================================================

import noiseGateUrl from './noise-gate-worklet.js?url';

export interface NoiseGateOptions {
  /** Open threshold in dBFS. Crossing above this snaps the gate open. */
  openDb?: number;
  /** Close threshold in dBFS. Must undershoot this for holdSec to release. */
  closeDb?: number;
  /** Hold time in seconds. Re-armed every time env crosses above closeDb. */
  holdSec?: number;
  /** Gate-open ramp time (sec). */
  attackSec?: number;
  /** Gate-close ramp time (sec) once hold elapses. */
  releaseSec?: number;
  /** Input envelope smoothing time (sec). */
  envSmoothSec?: number;
}

const DEFAULTS: Required<NoiseGateOptions> = {
  openDb: -45,
  closeDb: -55,
  holdSec: 0.25,
  attackSec: 0.005,
  releaseSec: 0.08,
  envSmoothSec: 0.020,
};

export class NoiseGate {
  readonly ctx: AudioContext;
  /** Connect upstream to this; downstream pulls from the same node. */
  readonly node: AudioWorkletNode;

  private constructor(ctx: AudioContext, node: AudioWorkletNode) {
    this.ctx = ctx;
    this.node = node;
  }

  static async create(ctx: AudioContext, opts: NoiseGateOptions = {}): Promise<NoiseGate> {
    const merged: Required<NoiseGateOptions> = { ...DEFAULTS, ...opts };
    await ctx.audioWorklet.addModule(noiseGateUrl);

    const node = new AudioWorkletNode(ctx, 'noise-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });
    node.parameters.get('openDb')!.value = merged.openDb;
    node.parameters.get('closeDb')!.value = merged.closeDb;
    node.parameters.get('hold')!.value = merged.holdSec;
    node.parameters.get('attack')!.value = merged.attackSec;
    node.parameters.get('release')!.value = merged.releaseSec;
    node.parameters.get('envSmooth')!.value = merged.envSmoothSec;

    return new NoiseGate(ctx, node);
  }

  setOpenDb(db: number): void {
    this.node.parameters.get('openDb')!.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
  setCloseDb(db: number): void {
    this.node.parameters.get('closeDb')!.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
  setHoldSec(sec: number): void {
    this.node.parameters.get('hold')!.setTargetAtTime(sec, this.ctx.currentTime, 0.01);
  }
}
