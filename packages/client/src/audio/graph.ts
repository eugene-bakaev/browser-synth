// Vue-free audio-graph primitives shared by the live AudioEngine and the
// offline Tier-2 harness. Kept out of AudioEngine.ts (which imports Vue) so
// the audio-lab harness can import these without pulling Vue into its bundle.
import type { EngineType } from '../project';
import { SoundEngine } from '../engine/types';
import { SynthEngine } from '../engine/SynthEngine';
import { KickEngine }  from '../engine/KickEngine';
import { HatEngine }   from '../engine/HatEngine';
import { SnareEngine } from '../engine/SnareEngine';
import { ClapEngine }  from '../engine/ClapEngine';
import { Synth2Engine } from '../engine/Synth2Engine';
import { Kick2Engine } from '../engine/Kick2Engine';
import { Snare2Engine } from '../engine/Snare2Engine';
import { Hat2Engine } from '../engine/Hat2Engine';
import { Clap2Engine } from '../engine/Clap2Engine';

// Pulse worklet — a Vite module-graph asset (emitted via new URL(...,
// import.meta.url)). Path is identical from audio/ as it was in AudioEngine.ts.
const pulseWorkletUrl = new URL('../engine/worklets/pulse-processor.js', import.meta.url).href;
// The five *2 worklets — esbuild-bundled static assets under public/worklets.
const synth2WorkletUrl = '/worklets/synth2-processor.js';
const kick2WorkletUrl  = '/worklets/kick2-processor.js';
const snare2WorkletUrl = '/worklets/snare2-processor.js';
const hat2WorkletUrl   = '/worklets/hat2-processor.js';
const clap2WorkletUrl  = '/worklets/clap2-processor.js';

export const engineFactories: Record<EngineType, (ctx: AudioContext, dest: AudioNode) => SoundEngine> = {
  synth:  (ctx, dest) => new SynthEngine(ctx, dest),
  kick:   (ctx, dest) => new KickEngine(ctx, dest),
  hat:    (ctx, dest) => new HatEngine(ctx, dest),
  snare:  (ctx, dest) => new SnareEngine(ctx, dest),
  clap:   (ctx, dest) => new ClapEngine(ctx, dest),
  synth2: (ctx, dest) => new Synth2Engine(ctx, dest),
  kick2:  (ctx, dest) => new Kick2Engine(ctx, dest),
  snare2: (ctx, dest) => new Snare2Engine(ctx, dest),
  hat2:   (ctx, dest) => new Hat2Engine(ctx, dest),
  clap2:  (ctx, dest) => new Clap2Engine(ctx, dest),
};

// Mixer slider position 0..1 (perceptual) -> linear gain via -54..+6 dB. 0 is
// hard silence. Display formula lives in Knob.vue case 'db' — keep in sync.
export function sliderToLinearGain(slider: number): number {
  if (slider <= 0) return 0;
  const db = -54 + slider * 60;
  return Math.pow(10, db / 20);
}

export interface MasterChain { input: AudioNode; output: AudioNode }

/** Compressor -> masterGain, wired. `input` is the compressor (connect track
 *  gains here); `output` is the masterGain (connect to ctx.destination). */
export function buildMasterChain(ctx: BaseAudioContext): MasterChain {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-12, ctx.currentTime);
  compressor.knee.setValueAtTime(30, ctx.currentTime);
  compressor.ratio.setValueAtTime(12, ctx.currentTime);
  compressor.attack.setValueAtTime(0.003, ctx.currentTime);
  compressor.release.setValueAtTime(0.25, ctx.currentTime);
  const masterGain = ctx.createGain();
  masterGain.gain.setValueAtTime(0.6, ctx.currentTime);
  compressor.connect(masterGain);
  return { input: compressor, output: masterGain };
}

/** Register every worklet module the engines need, in the app's order. Both
 *  the live AudioContext and the harness OfflineAudioContext call this. */
export async function registerWorklets(ctx: BaseAudioContext): Promise<void> {
  await ctx.audioWorklet.addModule(pulseWorkletUrl);
  await ctx.audioWorklet.addModule(synth2WorkletUrl);
  await ctx.audioWorklet.addModule(kick2WorkletUrl);
  await ctx.audioWorklet.addModule(snare2WorkletUrl);
  await ctx.audioWorklet.addModule(hat2WorkletUrl);
  await ctx.audioWorklet.addModule(clap2WorkletUrl);
}
