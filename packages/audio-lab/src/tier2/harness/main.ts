import type { Project } from '@fiddle/shared';
import { resolveStepTriggers, stepDuration } from '@fiddle/client/src/sequencer/schedule';
import { engineFactories, sliderToLinearGain, buildMasterChain, registerWorklets } from '@fiddle/client/src/audio/graph';

const SR = 48000;
const TAIL_SECONDS = 2.0; // let the last step's release/tail finish

function f32ToBase64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = '';
  const CHUNK = 0x8000; // chunk so String.fromCharCode doesn't blow the stack
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Faithful to AudioEngine.updateMixerGains, plus the CLI --solo override.
function trackGain(project: Project, i: number, soloTrack?: number): number {
  const track = project.tracks[i];
  if (!track.enabled) return 0;
  if (soloTrack !== undefined) return i === soloTrack ? sliderToLinearGain(track.mixer.volume) : 0;
  const anySoloed = project.tracks.some((t) => t.enabled && t.mixer.soloed);
  const audible = anySoloed ? (track.mixer.soloed && !track.mixer.muted) : !track.mixer.muted;
  return audible ? sliderToLinearGain(track.mixer.volume) : 0;
}

async function renderProject(project: Project, opts: { bars: number; soloTrack?: number }) {
  const bpm = project.bpm;
  const totalSteps = opts.bars * 16;
  const dur = totalSteps * stepDuration(bpm) + TAIL_SECONDS;
  const ctx = new OfflineAudioContext(2, Math.ceil(dur * SR), SR);
  await registerWorklets(ctx);

  const master = buildMasterChain(ctx);
  master.output.connect(ctx.destination);

  const engines: (ReturnType<(typeof engineFactories)[keyof typeof engineFactories]> | undefined)[] =
    new Array(project.tracks.length).fill(undefined);
  for (let i = 0; i < project.tracks.length; i++) {
    const track = project.tracks[i];
    const g = ctx.createGain();
    g.gain.value = trackGain(project, i, opts.soloTrack);
    g.connect(master.input);
    if (!track.enabled) continue;
    // OfflineAudioContext is a BaseAudioContext; the engine ctors only use
    // BaseAudioContext members, so the cast is runtime-safe.
    const engine = engineFactories[track.engineType](ctx as unknown as AudioContext, g);
    // NB: synth2 tempo-synced LFO/env/glide derivation lives in AudioEngine and
    // is a sub-project C concern; here stored (free) values are applied as-is.
    engine.applyParams(track.engines[track.engineType] as unknown as Record<string, unknown>);
    engines[i] = engine;
  }

  for (let k = 0; k < totalSteps; k++) {
    const t = k * stepDuration(bpm);
    for (const ev of resolveStepTriggers(project, k, t)) {
      engines[ev.trackIndex]?.trigger(ev.freq, ev.duration, ev.time, ev.velocity);
    }
  }

  // Flush queued worklet port messages (params + triggers) to the audio thread
  // before rendering — otherwise the OfflineAudioContext renders silence.
  await new Promise((r) => setTimeout(r, 100));

  const buf = await ctx.startRendering();
  return {
    channels: [f32ToBase64(buf.getChannelData(0)), f32ToBase64(buf.getChannelData(1))],
    sampleRate: SR,
  };
}

(window as unknown as { renderProject: typeof renderProject }).renderProject = renderProject;
