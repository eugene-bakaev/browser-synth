import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { freshProject } from '../project';
import { TRACK_POOL_SIZE } from '@fiddle/shared';
import { createAppRuntime, type AppRuntime } from './AppRuntime';
import { createSynthContext } from './synthContext';

// Same minimal Web Audio mock as AudioEngine.test — synthContext touches
// AudioContext transitively via ensureAudio().
class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  context = { currentTime: 0 };
}
class MockAudioParam {
  value = 0;
  cancelScheduledValues = vi.fn();
  cancelAndHoldAtTime = vi.fn();
  setValueAtTime = vi.fn();
  linearRampToValueAtTime = vi.fn();
  exponentialRampToValueAtTime = vi.fn();
  setTargetAtTime = vi.fn().mockImplementation((val: number) => { this.value = val; });
}
class MockGainNode extends MockAudioNode { gain = new MockAudioParam(); }
class MockOscillatorNode extends MockAudioNode {
  frequency = new MockAudioParam();
  detune = new MockAudioParam();
  type = 'sine';
  start = vi.fn();
  stop = vi.fn();
}
class MockBiquadFilterNode extends MockAudioNode {
  frequency = new MockAudioParam();
  Q = new MockAudioParam();
  type = 'lowpass';
}
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam();
  knee = new MockAudioParam();
  ratio = new MockAudioParam();
  attack = new MockAudioParam();
  release = new MockAudioParam();
}
class MockAnalyserNode extends MockAudioNode { fftSize = 1024; }
class MockAudioWorkletNode extends MockAudioNode {
  parameters = new Map<string, MockAudioParam>([
    ['frequency',  new MockAudioParam()],
    ['detune',     new MockAudioParam()],
    ['pulseWidth', new MockAudioParam()],
  ]);
}
class MockAudioContext {
  state = 'suspended';
  currentTime = 0;
  sampleRate = 44100;
  destination = new MockAudioNode();
  audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
  close = vi.fn().mockResolvedValue(undefined);
  resume = vi.fn().mockImplementation(() => { this.state = 'running'; return Promise.resolve(); });
  createGain() { return new MockGainNode(); }
  createOscillator() { return new MockOscillatorNode(); }
  createBiquadFilter() { return new MockBiquadFilterNode(); }
  createDynamicsCompressor() { return new MockDynamicsCompressorNode(); }
  createAnalyser() { return new MockAnalyserNode(); }
}

vi.stubGlobal('AudioNode', MockAudioNode);
vi.stubGlobal('AudioParam', MockAudioParam);
vi.stubGlobal('AudioContext', MockAudioContext);
vi.stubGlobal('AudioWorkletNode', MockAudioWorkletNode);

// A minimal stand-in for WsClient: records what the Outbox hands it and lets a
// test drive inbound messages via the captured onMessage callback. Wired in
// through the runtime's wsClientFactory so ensureAudio() never opens a real socket.
function makeFakeWsClient(opts: any) {
  let seq = 0;
  return {
    _opts: opts,
    sent: [] as any[],
    state: 'closed' as string,
    serverCapabilities: [] as string[],
    connect: vi.fn(),
    disconnect: vi.fn(),
    reconnect: vi.fn(),
    send(op: any) { this.sent.push(op); },
    isLive: () => true,
    nextClientSeq: () => ++seq,
    recordOpIdSeen: vi.fn(),
    opIdLastSeen: vi.fn(() => 0),
    requestResync: vi.fn(),
    getPersisted: () => null,
  };
}

// Fresh runtime + context per call (replaces the old per-test module reset). All
// built sockets are collected in `built`; `getFake` returns the most recent one.
const runtimesToCleanup: AppRuntime[] = [];
function makeCtx(o: { sync?: boolean } = {}) {
  const built: any[] = [];
  const runtime = createAppRuntime({
    syncEnabled: o.sync ?? false,
    wsClientFactory: (opts: any) => { const f = makeFakeWsClient(opts); built.push(f); return f as any; },
  });
  runtimesToCleanup.push(runtime);
  const ctx = createSynthContext(runtime);
  return { runtime, ctx, built, getFake: () => built[built.length - 1] };
}

// Tear down every runtime a test created (audio ctx/engines/fade-timers + socket)
// so no timer or context outlives its test. Replaces the old disposeSynth() calls.
afterEach(() => { for (const r of runtimesToCleanup.splice(0)) r.shutdown(); });

describe('audio reactions via the command stream (A2)', () => {
  it('forwards only the changed key when one synth param is dispatched', async () => {
    const { ctx } = makeCtx({ sync: false });
    const state = await ctx.ensureAudio();
    const engine = state.engines[0]!;
    const applySpy = vi.spyOn(engine, 'applyParams');
    applySpy.mockClear();

    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
  });

  it('forwards the full ADSR object (live superset) when an envelope leaf is dispatched', async () => {
    const { ctx } = makeCtx({ sync: false });
    const state = await ctx.ensureAudio();
    const engine = state.engines[0]!;
    const applySpy = vi.spyOn(engine, 'applyParams');
    applySpy.mockClear();

    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a'], 0.123);

    // A nested-leaf edit re-reads its whole top-level sub-object from live
    // state (superset apply) — only the filterEnv key, not the other params.
    expect(applySpy).toHaveBeenCalledTimes(1);
    const call = applySpy.mock.calls[0][0] as Record<string, any>;
    expect(Object.keys(call)).toEqual(['filterEnv']);
    expect(call).toEqual({ filterEnv: expect.objectContaining({ a: 0.123 }) });
  });

  it('skips applyParams when an inactive engine slice is dispatched', async () => {
    const { ctx } = makeCtx({ sync: false });
    const state = await ctx.ensureAudio();
    const synthEngine = state.engines[0]!; // track 0 starts as synth
    const applySpy = vi.spyOn(synthEngine, 'applyParams');
    applySpy.mockClear();

    // Dispatch to the kick slice on track 0 while engineType is still 'synth'.
    ctx.dispatchLocal(['tracks', 0, 'engines', 'kick', 'tune'], 80);

    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe('lazy per-slot engines (E1)', () => {
  it('builds engines only for enabled slots', async () => {
    const { ctx } = makeCtx({ sync: false });
    const state = await ctx.ensureAudio();
    const enabledCount = ctx.project.tracks.filter((t: any) => t.enabled).length;
    const builtCount = state.engines.filter((e: any) => e !== undefined).length;
    expect(builtCount).toBe(enabledCount); // 4 on a fresh project, not 32
    expect(state.engines[0]).toBeDefined();
    expect(state.engines[TRACK_POOL_SIZE - 1]).toBeUndefined();
  });

  it('constructs the engine on enable and fade-disposes it on disable', async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx({ sync: false });
    const state = await ctx.ensureAudio();
    expect(state.engines[10]).toBeUndefined();

    // Enable: the synchronous stream reaction builds the engine immediately.
    ctx.dispatchLocal(['tracks', 10, 'enabled'], true);
    const engine = state.engines[10]!;
    expect(engine).toBeDefined();
    const disposeSpy = vi.spyOn(engine, 'dispose');

    // Disable: the slot empties at once; dispose waits out the anti-click fade.
    ctx.dispatchLocal(['tracks', 10, 'enabled'], false);
    expect(state.engines[10]).toBeUndefined();
    expect(disposeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('pre-enable param edits land when the engine is built on enable', async () => {
    const { ctx } = makeCtx({ sync: false });
    const state = await ctx.ensureAudio();
    // Edit a disabled slot's slice — no engine yet, nothing to crash.
    ctx.dispatchLocal(['tracks', 10, 'engines', 'synth', 'filterCutoff'], 1234);
    expect(state.engines[10]).toBeUndefined();

    ctx.dispatchLocal(['tracks', 10, 'enabled'], true);
    // syncTrackToEngine applies the whole slice at construction — SynthEngine
    // records the cutoff in baseCutoff.
    expect(state.engines[10]).toBeDefined();
    expect((state.engines[10] as any).baseCutoff).toBe(1234);
  });
});

describe('sync integration', () => {
  async function bootWithFakeSocket() {
    const { runtime, ctx, getFake } = makeCtx({ sync: true });
    await ctx.ensureAudio();
    ctx.connectToSession('testroom1'); // explicit (was auto on ensureAudio)
    const fake = getFake()!;
    // Drive a fresh-join handshake: snapshot (applies content) then sync.complete
    // (opens the outbound-sync gate, syncReady). The gate keys on sync.complete —
    // not snapshot — so resumed connections that catch up via op replay still open
    // it. Fresh project == post-connect reset state, so applying it produces no ops.
    fake._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    fake._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    return { runtime, ctx, fake };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // buildConnection resolves the room from window.location and builds a ws://
    // URL from location — stub both for the node test env.
    vi.stubGlobal('window', {
      location: { pathname: '/r/testroom1' },
      history: { replaceState: vi.fn() },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/r/testroom1' });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('emits a leaf op via dispatchLocal for engine params', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);
    vi.advanceTimersByTime(50); // clear the 50ms throttle window
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'engines', 'synth', 'filterCutoff']);
    expect(fake.sent[0].value).toBe(1234);
  });

  it('drills nested ADSR edits to leaf paths (no whole-object writes)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a'], 0.123);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a']);
    expect(fake.sent[0].value).toBe(0.123);
  });

  it('applies a remote op without echoing it back out (suppression holds)', async () => {
    const { fake, ctx } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: 777,
    });
    expect(ctx.project.tracks[0].engines.synth.filterCutoff).toBe(777);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('a self-echo does not snap a knob back mid-drag (M2)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    // Drag starts: dispatch first value; flushes after the throttle window → in flight.
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1000);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    const seq = fake.sent[0].clientSeq;

    // Drag continues: dispatch a newer local value (still throttled).
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1100);

    // The echo of the OLDER flushed value arrives (~RTT later). It must not
    // overwrite the newer local value.
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'me', clientSeq: seq,
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: 1000,
    });
    expect(ctx.project.tracks[0].engines.synth.filterCutoff).toBe(1100);

    // The newer value still goes out on the next throttle flush.
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(2);
    expect(fake.sent[1].value).toBe(1100);
  });

  it('rolls back the local value on nack', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1500);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    const clientSeq = fake.sent[0].clientSeq;
    fake._opts.onMessage({
      v: 1, type: 'nack', clientSeq, code: 'value.invalid', message: 'too high',
    });
    expect(ctx.project.tracks[0].engines.synth.filterCutoff).toBe(2000); // default restored
  });

  it('emits an engineType swap via dispatch (discrete)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.dispatchLocal(['tracks', 0, 'engineType'], 'kick');
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']));
    expect(op?.value).toBe('kick');
  });

  it('a direct engineType mutation no longer emits (watcher removed)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.project.tracks[0].engineType = 'hat';
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']))).toBeUndefined();
  });

  it('addTrack emits ONE whole-track reset op (fresh + enabled), not a bare enabled op', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    const firstDisabled = ctx.project.tracks.findIndex((t: any) => !t.enabled);
    ctx.addTrack();
    const trackOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', firstDisabled]));
    expect(trackOp).toBeDefined();
    expect(trackOp.value.enabled).toBe(true);
    expect(trackOp.value.engineType).toBe('synth');
    // No per-leaf enabled op any more (that path resurrected the deleted track).
    const leafEnabled = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', firstDisabled, 'enabled']));
    expect(leafEnabled).toBeUndefined();
  });

  it('emits mixer muted (immediate) and volume (throttled) as leaf ops via dispatch', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.dispatchLocal(['tracks', 1, 'mixer', 'muted'], true); // discrete → immediate
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']))?.value).toBe(true);

    ctx.dispatchLocal(['tracks', 1, 'mixer', 'volume'], 0.5); // continuous → throttled
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))).toBeUndefined();
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))?.value).toBe(0.5);
  });

  it('a direct mixer mutation no longer emits (watcher removed)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.project.tracks[1].mixer.muted = false;
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']))).toBeUndefined();
  });

  it('emits a synth2 osc.sync toggle immediately (discrete leaf)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'osc2', 'sync'], true);
    // No timer advance: sync is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'osc2', 'sync']));
    expect(op).toBeDefined();
    expect(op.value).toBe(true);
  });

  it('emits a synth2 env1.loop toggle immediately (discrete leaf) (I3c)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'env1', 'loop'], true);
    // No timer advance: 'loop' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'env1', 'loop']));
    expect(op).toBeDefined();
    expect(op.value).toBe(true);
  });

  it('emits a synth2 filter.type change immediately (discrete enum leaf)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'type'], 'hp');
    // No timer advance: 'type' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'type']),
    );
    expect(op).toBeDefined();
    expect(op.value).toBe('hp');
  });

  it('filter.morph change and filter.model flip converge to a remote client (no echo) (I3d)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;

    // filter.model is a discrete enum flip — flushes immediately, no timer needed.
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'model'], 'morph');
    const modelOp = fake.sent.find(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'model']),
    );
    expect(modelOp).toBeDefined();
    expect(modelOp.value).toBe('morph');

    // filter.morph is continuous — rides the 50ms throttle.
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'morph'], 1.5);
    vi.advanceTimersByTime(50);
    const morphOp = fake.sent.find(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'morph']),
    );
    expect(morphOp).toBeDefined();
    expect(morphOp.value).toBeCloseTo(1.5, 6);

    // Simulate the remote client applying both ops back (the convergence half):
    // a second client receiving these as inbound 'set' ops must land on the same
    // values, and applying them must not re-emit (suppression holds).
    fake.sent.length = 0;
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'filter', 'model'], value: 'morph',
    });
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 2, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'filter', 'morph'], value: 1.5,
    });
    expect(ctx.project.tracks[0].engines.synth2.filter.model).toBe('morph');
    expect(ctx.project.tracks[0].engines.synth2.filter.morph).toBeCloseTo(1.5, 6);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('emits a synth2 matrix source change via dispatch, exactly one op (discrete leaf) (I3a)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source'], 'env2');
    // No timer advance: 'source' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const ops = fake.sent.filter(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source']),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].value).toBe('env2');
  });

  it('emits a synth2 matrix amount via dispatch (throttled) and never a whole-slot write (I3a)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount'], 0.3);
    const path0 = JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount']);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === path0)).toBeUndefined();
    vi.advanceTimersByTime(50);
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === path0);
    expect(op?.value).toBeCloseTo(0.3);
    // The array guard prevents a forbidden whole-slot object write.
    for (const o of fake.sent) {
      expect(o.path).not.toEqual(['tracks', 0, 'engines', 'synth2', 'matrix', 0]);
    }
  });

  it('emits a step note op via dispatch (discrete leaf)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.dispatchLocal(['tracks', 0, 'steps', 0, 'note'], 'C');
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'note']));
    expect(op?.value).toBe('C');
  });

  it('emits a step octave op via dispatch (discrete leaf)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.dispatchLocal(['tracks', 0, 'steps', 2, 'octave'], 5);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 2, 'octave']))?.value).toBe(5);
  });

  it('a direct step mutation no longer emits (watcher removed)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.project.tracks[0].steps[0].octave = 7;
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'octave']))).toBeUndefined();
  });

  it('applies a remote mixer op without echoing it back out', async () => {
    const { fake, ctx } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 2, 'mixer', 'volume'], value: 0.3,
    });
    expect(ctx.project.tracks[2].mixer.volume).toBe(0.3);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('emits a patternLength op via dispatch', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 32);
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength']));
    expect(op?.value).toBe(32);
  });

  it('applies a remote patternLength op without echoing it back out', async () => {
    const { fake, ctx } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'patternLength'], value: 12,
    });
    expect(ctx.project.tracks[0].patternLength).toBe(12);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('applies a remote matrix op without echoing it back out (I3a suppression)', async () => {
    const { fake, ctx } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source'], value: 'env2',
    });
    expect(ctx.project.tracks[0].engines.synth2.matrix[1].source).toBe('env2');
    vi.advanceTimersByTime(50);
    expect(
      fake.sent.find((o: any) =>
        JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source']),
      ),
    ).toBeUndefined();
  });

  it('emits a synth2 lfo1.rate change to a leaf path (throttled continuous) (I3b)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], 12);
    vi.advanceTimersByTime(50); // clear the throttle window
    const op = fake.sent.find(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate']),
    );
    expect(op).toBeDefined();
    expect(op!.value).toBe(12);
    // never a whole-module write
    expect(fake.sent.some(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1']),
    )).toBe(false);
  });

  it('applies a remote lfo1.rate op without echoing it back out (I3b)', async () => {
    const { fake, ctx } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], value: 7,
    });
    expect(ctx.project.tracks[0].engines.synth2.lfo1.rate).toBe(7);
    vi.advanceTimersByTime(100);
    expect(fake.sent.some(
      (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate']),
    )).toBe(false);
  });

  it('stopPlayback halts a running sequencer and resets the step cursor', async () => {
    const { ctx } = await bootWithFakeSocket();
    await ctx.togglePlay();
    expect(ctx.sequencer.isPlaying).toBe(true);

    ctx.stopPlayback();
    expect(ctx.sequencer.isPlaying).toBe(false);
    expect(ctx.currentStep.value).toBe(-1);

    // No-op when already stopped (e.g. navigating to the lobby twice).
    expect(() => ctx.stopPlayback()).not.toThrow();
    expect(ctx.sequencer.isPlaying).toBe(false);
  });

  it('passes getToken to the WsClient factory', async () => {
    const { fake } = await bootWithFakeSocket();
    expect(typeof fake._opts.getToken).toBe('function');
  });

  it('reconnects the WsClient when the auth session changes', async () => {
    const { fake } = await bootWithFakeSocket();
    // The session wired its watcher against the singleton useAuth() module.
    const { useAuth } = await import('../auth/useAuth');
    const auth = useAuth();
    expect(fake.reconnect).not.toHaveBeenCalled();
    fake.state = 'live'; // simulate a connected socket for the reconnect guard
    auth.session.value = { user: { id: 'u-1' }, access_token: 'tok-1' } as any;
    await nextTick();
    expect(fake.reconnect).toHaveBeenCalled();
  });

  it('leaveSession flushes throttled pending edits before the socket closes', async () => {
    const { fake, ctx } = await bootWithFakeSocket();
    // volume is a continuous field — gestureEndForLeaf('volume') === false → throttled (pending).
    ctx.dispatchLocal(['tracks', 1, 'mixer', 'volume'], 0.42);
    fake.sent.length = 0; // clear any previous ops
    ctx.leaveSession();
    expect(fake.sent.some((o: any) =>
      JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']) && o.value === 0.42,
    )).toBe(true);
  });

  it('emits a bpm op via the bpm computed setter (dispatch path)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.bpm.value = 132; // writable computed → dispatchLocal(['bpm'], 132)
    vi.advanceTimersByTime(50); // bpm rides the 50ms throttle
    const op = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['bpm']));
    expect(op?.value).toBe(132);
  });

  it('a direct project.bpm mutation no longer emits (watcher removed)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    ctx.project.bpm = 99; // direct mutation — no outbound watcher should catch it
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['bpm']))).toBeUndefined();
  });

  it('engine param edit via dispatch emits exactly one op (no double-emit)', async () => {
    const { ctx, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    ctx.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'cutoff'], 3000);
    vi.advanceTimersByTime(50);
    const ops = fake.sent.filter((o: any) => o.path.join('.') === 'tracks.0.engines.synth2.filter.cutoff');
    expect(ops).toHaveLength(1);
    expect(ops[0].value).toBe(3000);
  });

  describe('openProject bulk path', () => {
    it('uses sendLoad (one call, zero enqueues) when canBulkLoad', async () => {
      const { ctx, fake, runtime } = await bootWithFakeSocket();
      fake.serverCapabilities = ['load']; // server advertises the capability
      const sendSpy = vi.spyOn(runtime.session, 'sendProjectLoad');
      const enqueueSpy = vi.spyOn(runtime.session, 'enqueue');

      const preOpenSnapshot = freshProject(); // bootWithFakeSocket's snapshot === fresh
      const distinctive = freshProject();
      distinctive.bpm = 155;

      ctx.projectOps.openProject(distinctive);

      expect(sendSpy).toHaveBeenCalledTimes(1);
      expect(enqueueSpy).not.toHaveBeenCalled();

      const [sentNext, sentPrior] = sendSpy.mock.calls[0];
      expect(sentNext).toBe(distinctive);
      expect(sentPrior).not.toBe(ctx.project); // not the live reactive project
      expect(sentPrior).toEqual(preOpenSnapshot); // deep-equals the pre-open state

      // Independent clone, not a live alias: mutating the (now-replaced) live
      // project after the load must not reach back into the captured prior.
      ctx.project.tracks[0].mixer.volume = 0.02;
      expect((sentPrior as any).tracks[0].mixer.volume).not.toBe(0.02);
    });

    it('falls back to the leaf diff when the capability is absent', async () => {
      const { ctx, fake, runtime } = await bootWithFakeSocket();
      // fake.serverCapabilities defaults to [] — canBulkLoad stays false.
      const sendSpy = vi.spyOn(runtime.session, 'sendProjectLoad');
      fake.sent.length = 0;

      const next = freshProject();
      next.bpm = 155;
      ctx.projectOps.openProject(next);

      expect(sendSpy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(50); // clear the bpm leaf's throttle window
      const bpmOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['bpm']));
      expect(bpmOp).toBeDefined();
      expect(bpmOp!.value).toBe(155);
    });

    it('offline: neither sendLoad nor enqueue (local-only, unchanged)', () => {
      const { ctx, runtime } = makeCtx({ sync: false });
      const sendSpy = vi.spyOn(runtime.session, 'sendProjectLoad');
      const enqueueSpy = vi.spyOn(runtime.session, 'enqueue');

      const next = freshProject();
      next.bpm = 155;
      ctx.projectOps.openProject(next);

      expect(ctx.project.bpm).toBe(155); // local state applied
      expect(sendSpy).not.toHaveBeenCalled();
      expect(enqueueSpy).not.toHaveBeenCalled();
    });
  });
});

describe('session-scoped connection', () => {
  let pushState: ReturnType<typeof vi.fn>;
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushState = vi.fn();
    replaceState = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { pushState, replaceState }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });

  function boot() {
    return makeCtx({ sync: true });
  }

  it('connectToSession builds + connects a socket for the room and tracks currentRoomId', async () => {
    const { ctx, built } = boot();
    ctx.connectToSession('room-a');
    await Promise.resolve();
    expect(built).toHaveLength(1);
    expect(built[0]._opts.roomId).toBe('room-a');
    expect(built[0].connect).toHaveBeenCalledTimes(1);
    expect(ctx.currentRoomId.value).toBe('room-a');
  });

  it('toggles roomLoading: true while catching up, false on sync.complete', () => {
    const { ctx, built } = boot();
    expect(ctx.roomLoading.value).toBe(false); // lobby — nothing loading
    ctx.connectToSession('room-a');
    expect(ctx.roomLoading.value).toBe(true); // connect → loader on

    // Snapshot alone doesn't clear it (a resumed connection has no snapshot);
    // the loader stays until the room reaches live on sync.complete.
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    expect(ctx.roomLoading.value).toBe(true);

    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    expect(ctx.roomLoading.value).toBe(false); // caught up → loader off
  });

  it('clears roomLoading on leaveSession', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a');
    expect(ctx.roomLoading.value).toBe(true);
    ctx.leaveSession();
    expect(ctx.roomLoading.value).toBe(false);
  });

  it('exposes a passive sessionName ref defaulting to null', () => {
    const { ctx } = boot();
    expect(ctx.sessionName.value).toBeNull();
  });

  it('is idempotent for the same room', () => {
    const { ctx, built } = boot();
    ctx.connectToSession('room-a');
    ctx.connectToSession('room-a');
    expect(built).toHaveLength(1);
  });

  it('re-opening the room you are already in does not push a duplicate history entry', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a', { history: 'push' });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledWith(null, '', '/r/room-a');
    // A no-op re-connect to the same room (e.g. clicking its lobby card again)
    // must not grow history with a second /r/room-a entry — otherwise browser
    // Back lands back on the studio instead of the previous page.
    ctx.connectToSession('room-a', { history: 'push' });
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('switching rooms disconnects the old socket and builds a new one', () => {
    const { ctx, built } = boot();
    ctx.connectToSession('room-a');
    ctx.connectToSession('room-b');
    expect(built).toHaveLength(2);
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(built[1]._opts.roomId).toBe('room-b');
    expect(ctx.currentRoomId.value).toBe('room-b');
  });

  it('leaveSession disconnects, clears currentRoomId, and resets the project', () => {
    const { ctx, built } = boot();
    ctx.connectToSession('room-a');
    ctx.project.bpm = 199;
    ctx.leaveSession();
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(ctx.currentRoomId.value).toBeNull();
    expect(ctx.project.bpm).toBe(120); // fresh project default
  });

  // --- Cross-session state-bleed guards ---
  // These pin the two-part fix: (1) the local project is reset on every room
  // switch, and (2) outbound sync is gated until the room's snapshot lands, so
  // stale / pre-load content can never be written up into the room.

  it('resets the local project when switching rooms (no stale content carries over)', () => {
    const { ctx, built } = boot();
    ctx.connectToSession('room-a');
    const snap = freshProject();
    snap.bpm = 200;
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: snap });
    expect(ctx.project.bpm).toBe(200); // room-a content applied

    ctx.connectToSession('room-b');
    // Before any room-b snapshot, room-a's content must be gone (reset to fresh).
    expect(ctx.project.bpm).toBe(120);
  });

  it('does not emit local edits until the room sync completes', async () => {
    const { ctx, built } = boot();
    await ctx.ensureAudio(); // audio up
    ctx.connectToSession('room-a');

    // Edit BEFORE catch-up completes — must not leak to the room (gate closed),
    // even after the snapshot has been applied.
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 8);
    expect(built[0].sent.length).toBe(0);

    // sync.complete → gate opens.
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 5); // discrete → flushes immediately
    expect(
      built[0].sent.some((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength'])),
    ).toBe(true);
  });

  // Regression: edits made BEFORE the first Play were silently dropped because the
  // outbound-sync watchers were installed by ensureAudio() (the audio bootstrap,
  // gated on a user gesture), not by connecting to the room. A user who changed an
  // engine / steps and only then pressed Play lost those edits — they never synced
  // or persisted, so a second client (or a reload) saw the un-edited server state.
  // Outbound sync must be live as soon as the room is, independent of audio.
  it('emits edits made before the first Play (sync does not require ensureAudio/audio)', () => {
    const { ctx, built } = boot();
    // NOTE: deliberately NO ensureAudio() — simulates editing before pressing Play.
    ctx.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    built[0].sent.length = 0; // ignore any catch-up ops

    // The exact repro: swap an engine before any AudioContext exists. engineType is
    // discrete (gestureEnd) so it flushes immediately — no timer advance needed.
    ctx.dispatchLocal(['tracks', 0, 'engineType'], 'kick');

    expect(
      built[0].sent.some(
        (o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']) && o.value === 'kick',
      ),
    ).toBe(true);
  });

  // Regression: a resumed connection catches up via op replay, NOT a snapshot, so
  // gating on snapshot left syncReady stuck false and silently dropped every edit
  // (sessions appeared to never persist). The gate must open on sync.complete,
  // which fires on the replay path with no snapshot at all.
  it('opens the outbound gate on sync.complete even when catch-up is op replay (no snapshot)', async () => {
    const { ctx, built } = boot();
    await ctx.ensureAudio(); // audio up
    ctx.connectToSession('room-a');

    // Resume/replay handshake: backfilled `set` ops, then sync.complete — never a
    // snapshot message.
    built[0]._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other', path: ['bpm'], value: 140,
    });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 1 });

    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 6); // discrete → flushes immediately
    expect(
      built[0].sent.some((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength'])),
    ).toBe(true);
  });

  it('does not flush the previous room\'s content into the new room on switch', async () => {
    const { ctx, built } = boot();
    await ctx.ensureAudio(); // audio up
    ctx.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 7); // legit edit to room-a
    expect(built[0].sent.length).toBeGreaterThan(0);

    ctx.connectToSession('room-b');
    // Gate closed + project reset: no ops to room-b before it syncs, even if
    // a reactive change fires.
    expect(built[1].sent.length).toBe(0);
    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 3);
    expect(built[1].sent.length).toBe(0);

    // After room-b syncs, edits flow to room-b again.
    built[1]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[1]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    ctx.dispatchLocal(['tracks', 0, 'patternLength'], 9);
    expect(
      built[1].sent.some((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength'])),
    ).toBe(true);
  });
});

describe('variable track count', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });

  async function boot() {
    const { runtime, ctx, built } = makeCtx({ sync: true });
    await ctx.ensureAudio(); // audio up
    return { runtime, ctx, built };
  }

  it('addTrack enables the lowest-index disabled slot and emits a whole-track reset op', async () => {
    const { ctx, built } = await boot();
    ctx.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    built[0].sent.length = 0; // clear ops emitted during catch-up

    ctx.addTrack();
    await nextTick();

    expect(ctx.project.tracks[4].enabled).toBe(true);
    expect(ctx.enabledTrackCount.value).toBe(5);
    // Atomic whole-track reset op, not a bare leaf 'enabled' write (that path
    // resurrected the deleted track's content — see the reset-on-add fix).
    expect(
      built[0].sent.some((m: any) => m.path.join('.') === 'tracks.4' && m.value.enabled === true),
    ).toBe(true);
  });

  it('removeTrack disables that slot but refuses to drop below 1 enabled', async () => {
    const { ctx, built } = await boot();
    ctx.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });

    ctx.removeTrack(3);
    await nextTick();
    expect(ctx.project.tracks[3].enabled).toBe(false);
    expect(ctx.enabledTrackCount.value).toBe(3);

    ctx.removeTrack(2);
    ctx.removeTrack(1);
    await nextTick();
    expect(ctx.enabledTrackCount.value).toBe(1);
    ctx.removeTrack(0);
    await nextTick();
    expect(ctx.enabledTrackCount.value).toBe(1); // unchanged — refused
    expect(ctx.project.tracks[0].enabled).toBe(true);
  });

  it('exposes all TRACK_POOL_SIZE slots in project.tracks', async () => {
    const { ctx } = await boot();
    expect(ctx.project.tracks).toHaveLength(TRACK_POOL_SIZE);
  });

  it('addTrack appends the reused slot to the end of trackOrder', async () => {
    const { runtime, ctx } = await boot();
    // Free a middle slot, then re-add: the slot re-enables (lowest free index)
    // but must DISPLAY last (spec: new tracks always appear at the end).
    ctx.removeTrack(1);
    ctx.addTrack();
    const { project } = runtime.store;
    expect(project.tracks[1].enabled).toBe(true);
    const enabledInOrder = project.trackOrder.filter((i) => project.tracks[i].enabled);
    expect(enabledInOrder[enabledInOrder.length - 1]).toBe(1);
  });

  it('addTrack on a fresh project shows the new slot last', async () => {
    const { runtime, ctx } = await boot();
    // Enabling slot 4 moves it past the disabled 5..31 in the raw order array
    // (display-equivalent — the invariant is the ENABLED projection, not the
    // raw array).
    ctx.addTrack();
    const { project } = runtime.store;
    const enabledInOrder = project.trackOrder.filter((i) => project.tracks[i].enabled);
    expect(enabledInOrder).toEqual([0, 1, 2, 3, 4]);
  });

  it('a trackOrder dispatch is undoable (object-leaf identity)', async () => {
    const { runtime, ctx } = await boot();
    const { project } = runtime.store;
    const before = [...project.trackOrder];
    const next = [...project.trackOrder].reverse();
    ctx.dispatchLocal(['trackOrder'], next);
    expect(project.trackOrder).toEqual(next);
    await Promise.resolve(); // let the undo burst seal (microtask)
    runtime.history.undo();
    expect([...project.trackOrder]).toEqual(before);
  });
});

describe('add-track reset-on-add (F-bug: add resurrects the deleted track)', () => {
  it('add after delete gives a BLANK track, not the deleted one', async () => {
    const { ctx } = makeCtx();
    // Dirty slot 3 (a default-enabled track): a note + a non-default engine.
    ctx.dispatchLocal(['tracks', 3, 'steps', 0, 'note'], 'C');
    ctx.dispatchLocal(['tracks', 3, 'engineType'], 'kick');
    ctx.removeTrack(3);           // disable slot 3 (enabledCount 4 → 3, allowed)
    ctx.addTrack();               // reuses the lowest disabled slot = 3
    expect(ctx.project.tracks[3].enabled).toBe(true);
    expect(ctx.project.tracks[3].engineType).toBe('synth');   // reset, not kick
    expect(ctx.project.tracks[3].steps[0].note).toBeNull();   // blank, not 'C'
  });

  it('undo of add restores the deleted track (content + disabled state)', async () => {
    const { runtime, ctx } = makeCtx();
    ctx.dispatchLocal(['tracks', 3, 'steps', 0, 'note'], 'C');
    await nextTick();             // seal as its own undo entry
    ctx.removeTrack(3);
    await nextTick();
    ctx.addTrack();
    await nextTick();             // seal the add (reset + trackOrder) as one entry
    expect(ctx.project.tracks[3].steps[0].note).toBeNull();   // blank after add
    runtime.history.undo();       // undo ONLY the add
    expect(ctx.project.tracks[3].enabled).toBe(false);        // deleted again
    expect(ctx.project.tracks[3].steps[0].note).toBe('C');    // content restored
  });
});

describe('Project boot (S1: no localStorage path)', () => {
  // The app is session-only: connectToSession resets state before the room
  // snapshot replaces it, so a localStorage-loaded project was never rendered —
  // and autosave silently overwrote the "local project" with whatever room the
  // user last visited. The boot path must therefore never touch localStorage.
  let lsStore: Map<string, string>;
  const lsImpl = {
    getItem: vi.fn((k: string) => lsStore.has(k) ? lsStore.get(k)! : null),
    setItem: vi.fn((k: string, v: string) => { lsStore.set(k, v); }),
    removeItem: (k: string) => { lsStore.delete(k); },
    clear: () => { lsStore.clear(); },
  };

  beforeEach(() => {
    lsStore = new Map();
    lsImpl.getItem.mockClear();
    lsImpl.setItem.mockClear();
    vi.stubGlobal('localStorage', lsImpl);
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('boots a fresh project, ignoring an old fiddle:project key', () => {
    const seed = { schemaVersion: 1, bpm: 144, tracks: [{}, {}, {}, {}] };
    lsStore.set('fiddle:project', JSON.stringify(seed));

    const { ctx } = makeCtx({ sync: false });
    expect(ctx.project.bpm).toBe(120); // fresh, not the stored 144
    expect(lsImpl.getItem).not.toHaveBeenCalled();
  });

  it('does not autosave mutations to localStorage', async () => {
    vi.useFakeTimers();
    const { ctx } = makeCtx({ sync: false });
    ctx.project.tracks[0].engines.synth.filterCutoff = 5678;
    await Promise.resolve();
    vi.advanceTimersByTime(1000); // past the old 500ms debounce
    vi.useRealTimers();

    expect(lsImpl.setItem).not.toHaveBeenCalled();
  });
});

describe('focused-track URL view-state', () => {
  let pushState: ReturnType<typeof vi.fn>;
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushState = vi.fn();
    replaceState = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { pushState, replaceState }, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });
  afterEach(() => vi.unstubAllGlobals());

  function boot() {
    return makeCtx({ sync: true });
  }

  it('selectTrack(n) opens the editor: pushes ?t=<n> (Back returns to overview) and focuses the track', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a'); // sets currentRoomId
    ctx.selectTrack(2);
    expect(pushState).toHaveBeenCalledWith(null, '', '/r/room-a?t=2');
    expect(ctx.activeTrackIndex.value).toBe(2);
  });

  it('selectTrack(null) leaves the editor: replaces with the bare room URL and shows the overview', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a');
    ctx.selectTrack(2);
    ctx.selectTrack(null);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/r/room-a');
    expect(ctx.activeTrackIndex.value).toBeNull();
  });

  it('setFocusedTrack(n) syncs the view from the URL without a new history entry (popstate path)', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a');
    ctx.setFocusedTrack(3);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/r/room-a?t=3');
    expect(pushState).not.toHaveBeenCalled();
    expect(ctx.activeTrackIndex.value).toBe(3);
  });

  it('entering a session resets a stale editor view to the overview (kills cross-session bleed-through)', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a');
    ctx.selectTrack(2);
    expect(ctx.activeTrackIndex.value).toBe(2);
    ctx.connectToSession('room-b'); // resets the view
    expect(ctx.activeTrackIndex.value).toBeNull();
  });

  it('leaving a session resets the editor view to the overview', () => {
    const { ctx } = boot();
    ctx.connectToSession('room-a');
    ctx.selectTrack(2);
    ctx.leaveSession(); // resets the view
    expect(ctx.activeTrackIndex.value).toBeNull();
  });

  it('selectTrack with no active room only sets the view (no URL write)', () => {
    const { ctx } = boot();
    ctx.selectTrack(1);
    expect(ctx.activeTrackIndex.value).toBe(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});

describe('endGesture undo tap', () => {
  it('endGesture closes the undo drag-merge window AND still flushes the path', () => {
    const { runtime, ctx } = makeCtx({ sync: false });
    const histSpy = vi.spyOn(runtime.history, 'endGesture');
    const flushSpy = vi.spyOn(runtime.session, 'flushPath');
    const path = ['tracks', 0, 'engines', 'synth', 'osc1Coarse'];
    ctx.endGesture(path);
    expect(histSpy).toHaveBeenCalledWith(path);
    expect(flushSpy).toHaveBeenCalledWith(path);
  });
});
