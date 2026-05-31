// ============================================================================
// noiseGate.ts
// ----------------------------------------------------------------------------
// Thin TypeScript wrapper around the noise-gate AudioWorkletProcessor.
// Provides an async factory that registers the processor module once and
// returns a NoiseGate instance with a single AudioNode you connect inline.
//
//   mic ──> NoiseGate.node ──> rest of audio graph
//
// All parameters are tunable from MAPPING.noiseGate in mapping.ts.
// ============================================================================

import noiseGateUrl from './noise-gate-worklet.js?url';

export interface NoiseGateOptions {
  /** Open the gate when input level exceeds this (dBFS). */
  thresholdDb?: number;
  /** Gate-open ramp time (seconds). */
  attackSec?: number;
  /** Gate-close ramp time (seconds). */
  releaseSec?: number;
  /** Input envelope smoothing time (seconds). */
  envSmoothSec?: number;
}

const DEFAULTS: Required<NoiseGateOptions> = {
  thresholdDb: -45,
  attackSec: 0.005,
  releaseSec: 0.1,
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

  /** Async factory -- registers the processor module the first time. */
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
    node.parameters.get('threshold')!.value = merged.thresholdDb;
    node.parameters.get('attack')!.value = merged.attackSec;
    node.parameters.get('release')!.value = merged.releaseSec;
    node.parameters.get('envSmooth')!.value = merged.envSmoothSec;

    return new NoiseGate(ctx, node);
  }

  setThresholdDb(db: number): void {
    this.node.parameters.get('threshold')!.setTargetAtTime(db, this.ctx.currentTime, 0.01);
  }
}
