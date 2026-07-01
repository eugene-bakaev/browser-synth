import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { freshProject } from '../project';
import { TRACK_POOL_SIZE } from '@fiddle/shared';

// Same minimal Web Audio mock as TrackMixer.test — useSynth touches AudioContext
// transitively via ensureAudio().
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
  // OscillatorModule constructs an AudioWorkletNode in its ctor; useSynth
  // awaits addModule before any voice is built. Mock both so the bootstrap
  // resolves and node creation doesn't throw.
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

let useSynth: any;
let disposeSynth: any;

describe('useSynth narrow watchers (A2)', () => {
  beforeEach(async () => {
    // Clear persisted project so each test gets a fresh module-scope project.
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    useSynth = mod.useSynth;
    disposeSynth = mod.disposeSynth;
    // These tests exercise the audio watchers only — keep the WS layer dark so
    // ensureAudio() doesn't open a real socket.
    mod.setSyncEnabled(false);
    // Reset audio state between tests so each gets a fresh engine to spy on.
    disposeSynth();
  });

  it('forwards only the changed key when one synth param is mutated', async () => {
    const synth = useSynth();
    const state = await synth.ensureAudio();
    const engine = state.engines[0];
    const applySpy = vi.spyOn(engine, 'applyParams');
    applySpy.mockClear();

    synth.project.tracks[0].engines.synth.filterCutoff = 1234;
    await nextTick();

    expect(applySpy).toHaveBeenCalledTimes(1);
    expect(applySpy).toHaveBeenCalledWith({ filterCutoff: 1234 });
  });

  it('forwards the full ADSR object when an envelope leaf is mutated', async () => {
    const synth = useSynth();
    const state = await synth.ensureAudio();
    const engine = state.engines[0];
    const applySpy = vi.spyOn(engine, 'applyParams');
    applySpy.mockClear();

    synth.project.tracks[0].engines.synth.filterEnv.a = 0.123;
    await nextTick();

    // ADSR objects are passed whole to applyParams (engine setter takes a/d/s/r
    // together) — but only the filterEnv key, not the other 12 synth params.
    expect(applySpy).toHaveBeenCalledTimes(1);
    const call = applySpy.mock.calls[0][0] as Record<string, any>;
    expect(Object.keys(call)).toEqual(['filterEnv']);
    expect(call.filterEnv).toMatchObject({ a: 0.123 });
  });

  it('skips applyParams when an inactive engine slice changes', async () => {
    const synth = useSynth();
    const state = await synth.ensureAudio();
    const synthEngine = state.engines[0]; // track 0 starts as synth
    const applySpy = vi.spyOn(synthEngine, 'applyParams');
    applySpy.mockClear();

    // Mutate the kick slice on track 0 while engineType is still 'synth'.
    synth.project.tracks[0].engines.kick.tune = 80;
    await nextTick();

    expect(applySpy).not.toHaveBeenCalled();
  });
});

describe('lazy per-slot engines (E1)', () => {
  // Same module bootstrap as the narrow-watchers suite above.
  beforeEach(async () => {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    useSynth = mod.useSynth;
    disposeSynth = mod.disposeSynth;
    mod.setSyncEnabled(false);
    disposeSynth();
  });

  it('builds engines only for enabled slots', async () => {
    const synth = useSynth();
    const state = await synth.ensureAudio();
    const enabledCount = synth.project.tracks.filter((t: any) => t.enabled).length;
    const builtCount = state.engines.filter((e: any) => e !== undefined).length;
    expect(builtCount).toBe(enabledCount); // 4 on a fresh project, not 32
    expect(state.engines[0]).toBeDefined();
    expect(state.engines[TRACK_POOL_SIZE - 1]).toBeUndefined();
  });

  it('constructs the engine on enable and fade-disposes it on disable', async () => {
    vi.useFakeTimers();
    const synth = useSynth();
    const state = await synth.ensureAudio();
    expect(state.engines[10]).toBeUndefined();

    // Enable: the flush:'sync' watcher builds the engine immediately.
    synth.project.tracks[10].enabled = true;
    const engine = state.engines[10];
    expect(engine).toBeDefined();
    const disposeSpy = vi.spyOn(engine, 'dispose');

    // Disable: the slot empties at once; dispose waits out the anti-click fade.
    synth.project.tracks[10].enabled = false;
    expect(state.engines[10]).toBeUndefined();
    expect(disposeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(30);
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('pre-enable param edits land when the engine is built on enable', async () => {
    const synth = useSynth();
    const state = await synth.ensureAudio();
    // Edit a disabled slot's slice — no engine yet, nothing to crash.
    synth.project.tracks[10].engines.synth.filterCutoff = 1234;
    expect(state.engines[10]).toBeUndefined();

    synth.project.tracks[10].enabled = true;
    // syncTrackToEngine applies the whole slice at construction — SynthEngine
    // records the cutoff in baseCutoff.
    expect(state.engines[10]).toBeDefined();
    expect((state.engines[10] as any).baseCutoff).toBe(1234);
  });
});

describe('sync integration', () => {
  // A minimal stand-in for WsClient: records what the Outbox hands it and lets
  // the test drive inbound messages via the captured onMessage callback. Wired
  // in through setWsClientFactory so ensureAudio() never opens a real socket.
  function makeFakeWsClient(opts: any) {
    let seq = 0;
    return {
      _opts: opts,
      sent: [] as any[],
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

  async function bootWithFakeSocket() {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    let fake: ReturnType<typeof makeFakeWsClient>;
    mod.setWsClientFactory((o: any) => { fake = makeFakeWsClient(o); return fake as any; });
    mod.setSyncEnabled(true);
    mod.disposeSynth();
    const synth = mod.useSynth();
    await synth.ensureAudio();
    mod.connectToSession('testroom1'); // explicit now (was auto on ensureAudio)
    // Drive a fresh-join handshake: snapshot (applies content) then sync.complete
    // (opens the outbound-sync gate, syncReady). The gate keys on sync.complete —
    // not snapshot — so resumed connections that catch up via op replay still open
    // it. Fresh project == post-connect reset state, so applying it produces no ops.
    fake!._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    fake!._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    return { mod, synth, fake: fake! };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // buildSyncState resolves the room from window.location and builds a ws://
    // URL from location — stub both for the node test env.
    vi.stubGlobal('window', {
      location: { pathname: '/r/testroom1' },
      history: { replaceState: vi.fn() },
      addEventListener: vi.fn(),
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/r/testroom1' });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('emits a leaf op via dispatchLocal for engine params', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1234);
    vi.advanceTimersByTime(50); // clear the 50ms throttle window
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'engines', 'synth', 'filterCutoff']);
    expect(fake.sent[0].value).toBe(1234);
  });

  it('drills nested ADSR edits to leaf paths (no whole-object writes)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a'], 0.123);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'engines', 'synth', 'filterEnv', 'a']);
    expect(fake.sent[0].value).toBe(0.123);
  });

  it('applies a remote op without echoing it back out (suppression holds)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: 777,
    });
    expect(synth.project.tracks[0].engines.synth.filterCutoff).toBe(777);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('a self-echo does not snap a knob back mid-drag (M2)', async () => {
    const { mod, fake, synth } = await bootWithFakeSocket();
    fake.sent.length = 0;
    // Drag starts: dispatch first value; flushes after the throttle window → in flight.
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1000);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    const seq = fake.sent[0].clientSeq;

    // Drag continues: dispatch a newer local value (still throttled).
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1100);

    // The echo of the OLDER flushed value arrives (~RTT later). It must not
    // overwrite the newer local value.
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'me', clientSeq: seq,
      path: ['tracks', 0, 'engines', 'synth', 'filterCutoff'], value: 1000,
    });
    expect(synth.project.tracks[0].engines.synth.filterCutoff).toBe(1100);

    // The newer value still goes out on the next throttle flush.
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(2);
    expect(fake.sent[1].value).toBe(1100);
  });

  it('rolls back the local value on nack', async () => {
    const { mod, fake, synth } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth', 'filterCutoff'], 1500);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    const clientSeq = fake.sent[0].clientSeq;
    fake._opts.onMessage({
      v: 1, type: 'nack', clientSeq, code: 'value.invalid', message: 'too high',
    });
    expect(synth.project.tracks[0].engines.synth.filterCutoff).toBe(2000); // default restored
  });

  it('emits an engineType swap via dispatch (discrete)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    mod.dispatchLocal(['tracks', 0, 'engineType'], 'kick');
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']));
    expect(op?.value).toBe('kick');
  });

  it('a direct engineType mutation no longer emits (watcher removed)', async () => {
    const { synth, fake } = await bootWithFakeSocket();
    synth.project.tracks[0].engineType = 'hat';
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']))).toBeUndefined();
  });

  it('addTrack emits an enabled op via dispatch', async () => {
    const { synth, fake } = await bootWithFakeSocket();
    const firstDisabled = synth.project.tracks.findIndex((t: any) => !t.enabled);
    synth.addTrack();
    const onOp = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', firstDisabled, 'enabled']));
    expect(onOp?.value).toBe(true);
  });

  it('emits mixer muted (immediate) and volume (throttled) as leaf ops via dispatch', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    mod.dispatchLocal(['tracks', 1, 'mixer', 'muted'], true); // discrete → immediate
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']))?.value).toBe(true);

    mod.dispatchLocal(['tracks', 1, 'mixer', 'volume'], 0.5); // continuous → throttled
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))).toBeUndefined();
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))?.value).toBe(0.5);
  });

  it('a direct mixer mutation no longer emits (watcher removed)', async () => {
    const { synth, fake } = await bootWithFakeSocket();
    synth.project.tracks[1].mixer.muted = false;
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']))).toBeUndefined();
  });

  it('emits a synth2 osc.sync toggle immediately (discrete leaf)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'osc2', 'sync'], true);
    // No timer advance: sync is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'osc2', 'sync']));
    expect(op).toBeDefined();
    expect(op.value).toBe(true);
  });

  it('emits a synth2 env1.loop toggle immediately (discrete leaf) (I3c)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'env1', 'loop'], true);
    // No timer advance: 'loop' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'env1', 'loop']));
    expect(op).toBeDefined();
    expect(op.value).toBe(true);
  });

  it('emits a synth2 filter.type change immediately (discrete enum leaf)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'type'], 'hp');
    // No timer advance: 'type' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const op = fake.sent.find(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'type']),
    );
    expect(op).toBeDefined();
    expect(op.value).toBe('hp');
  });

  it('filter.morph change and filter.model flip converge to a remote client (no echo) (I3d)', async () => {
    const { mod, fake, synth } = await bootWithFakeSocket();
    fake.sent.length = 0;

    // filter.model is a discrete enum flip — flushes immediately, no timer needed.
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'model'], 'morph');
    const modelOp = fake.sent.find(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'model']),
    );
    expect(modelOp).toBeDefined();
    expect(modelOp.value).toBe('morph');

    // filter.morph is continuous — rides the 50ms throttle.
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'morph'], 1.5);
    vi.advanceTimersByTime(50);
    const morphOp = fake.sent.find(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'filter', 'morph']),
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
    expect(synth.project.tracks[0].engines.synth2.filter.model).toBe('morph');
    expect(synth.project.tracks[0].engines.synth2.filter.morph).toBeCloseTo(1.5, 6);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('emits a synth2 matrix source change via dispatch, exactly one op (discrete leaf) (I3a)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source'], 'env2');
    // No timer advance: 'source' is in DISCRETE_LEAF_FIELDS → flushes immediately.
    const ops = fake.sent.filter(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source']),
    );
    expect(ops).toHaveLength(1);
    expect(ops[0].value).toBe('env2');
  });

  it('emits a synth2 matrix amount via dispatch (throttled) and never a whole-slot write (I3a)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount'], 0.3);
    const path0 = JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 0, 'amount']);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === path0)).toBeUndefined();
    vi.advanceTimersByTime(50);
    const op = fake.sent.find((o) => JSON.stringify(o.path) === path0);
    expect(op?.value).toBeCloseTo(0.3);
    // The array guard prevents a forbidden whole-slot object write.
    for (const o of fake.sent) {
      expect(o.path).not.toEqual(['tracks', 0, 'engines', 'synth2', 'matrix', 0]);
    }
  });

  it('emits a step note op via dispatch (discrete leaf)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    mod.dispatchLocal(['tracks', 0, 'steps', 0, 'note'], 'C');
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'note']));
    expect(op?.value).toBe('C');
  });

  it('emits a step octave op via dispatch (discrete leaf)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    mod.dispatchLocal(['tracks', 0, 'steps', 2, 'octave'], 5);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 2, 'octave']))?.value).toBe(5);
  });

  it('a direct step mutation no longer emits (watcher removed)', async () => {
    const { synth, fake } = await bootWithFakeSocket();
    synth.project.tracks[0].steps[0].octave = 7;
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'octave']))).toBeUndefined();
  });

  it('applies a remote mixer op without echoing it back out', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 2, 'mixer', 'volume'], value: 0.3,
    });
    expect(synth.project.tracks[2].mixer.volume).toBe(0.3);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('emits a patternLength op via dispatch', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    mod.dispatchLocal(['tracks', 0, 'patternLength'], 32);
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength']));
    expect(op?.value).toBe(32);
  });

  it('applies a remote patternLength op without echoing it back out', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'patternLength'], value: 12,
    });
    expect(synth.project.tracks[0].patternLength).toBe(12);
    vi.advanceTimersByTime(100);
    expect(fake.sent.length).toBe(0);
  });

  it('applies a remote matrix op without echoing it back out (I3a suppression)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source'], value: 'env2',
    });
    expect(synth.project.tracks[0].engines.synth2.matrix[1].source).toBe('env2');
    vi.advanceTimersByTime(50);
    expect(
      fake.sent.find((o: any) =>
        JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'matrix', 1, 'source']),
      ),
    ).toBeUndefined();
  });

  it('emits a synth2 lfo1.rate change to a leaf path (throttled continuous) (I3b)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], 12);
    vi.advanceTimersByTime(50); // clear the throttle window
    const op = fake.sent.find(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate']),
    );
    expect(op).toBeDefined();
    expect(op!.value).toBe(12);
    // never a whole-module write
    expect(fake.sent.some(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1']),
    )).toBe(false);
  });

  it('applies a remote lfo1.rate op without echoing it back out (I3b)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    fake._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other',
      path: ['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate'], value: 7,
    });
    expect(synth.project.tracks[0].engines.synth2.lfo1.rate).toBe(7);
    vi.advanceTimersByTime(100);
    expect(fake.sent.some(
      (o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engines', 'synth2', 'lfo1', 'rate']),
    )).toBe(false);
  });

  it('stopPlayback halts a running sequencer and resets the step cursor', async () => {
    const { synth } = await bootWithFakeSocket();
    await synth.togglePlay();
    expect(synth.sequencer.isPlaying).toBe(true);

    synth.stopPlayback();
    expect(synth.sequencer.isPlaying).toBe(false);
    expect(synth.currentStep.value).toBe(-1);

    // No-op when already stopped (e.g. navigating to the lobby twice).
    expect(() => synth.stopPlayback()).not.toThrow();
    expect(synth.sequencer.isPlaying).toBe(false);
  });

  it('passes getToken to the WsClient factory', async () => {
    const { fake } = await bootWithFakeSocket();
    expect(typeof fake._opts.getToken).toBe('function');
  });

  it('reconnects the WsClient when the auth session changes', async () => {
    const { fake } = await bootWithFakeSocket();
    // Import the same useAuth module instance the composable wired its watcher
    // against (resetModules already ran inside bootWithFakeSocket).
    const { useAuth } = await import('../auth/useAuth');
    const auth = useAuth();
    expect(fake.reconnect).not.toHaveBeenCalled();
    auth.session.value = { user: { id: 'u-1' }, access_token: 'tok-1' };
    await nextTick();
    expect(fake.reconnect).toHaveBeenCalled();
  });

  it('leaveSession flushes throttled pending edits before the socket closes', async () => {
    const { fake, mod } = await bootWithFakeSocket();
    // volume is a continuous field — gestureEndForLeaf('volume') === false → throttled (pending).
    mod.dispatchLocal(['tracks', 1, 'mixer', 'volume'], 0.42);
    fake.sent.length = 0; // clear any previous ops
    mod.leaveSession();
    expect(fake.sent.some((o: any) =>
      JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']) && o.value === 0.42,
    )).toBe(true);
  });

  it('emits a bpm op via the bpm computed setter (dispatch path)', async () => {
    const { synth, fake } = await bootWithFakeSocket();
    synth.bpm.value = 132; // writable computed → dispatchLocal(['bpm'], 132)
    vi.advanceTimersByTime(50); // bpm rides the 50ms throttle
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['bpm']));
    expect(op?.value).toBe(132);
  });

  it('a direct project.bpm mutation no longer emits (watcher removed)', async () => {
    const { synth, fake } = await bootWithFakeSocket();
    synth.project.bpm = 99; // direct mutation — no outbound watcher should catch it
    vi.advanceTimersByTime(50);
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['bpm']))).toBeUndefined();
  });

  // C1: syncStepWindowDiff — bulk step writes (Clear/Shift/Fill)
  it('syncStepWindowDiff emits changed step fields as leaf ops (C1)', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    const before = synth.project.tracks[0].steps.slice(0, 4).map((s: any) => ({ ...s }));
    synth.project.tracks[0].steps[0].note = 'C';
    synth.project.tracks[0].steps[2].note = 'D';
    mod.syncStepWindowDiff(0, before);
    // 'note' is discrete → no timer advance needed
    const noteOp0 = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'note']));
    expect(noteOp0?.value).toBe('C');
    const noteOp2 = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 2, 'note']));
    expect(noteOp2?.value).toBe('D');
  });

  it('syncStepWindowDiff emits nothing when the window is unchanged (C1 regression)', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    const before = synth.project.tracks[0].steps.slice(0, 4).map((s: any) => ({ ...s }));
    fake.sent.length = 0;
    mod.syncStepWindowDiff(0, before);
    expect(fake.sent.length).toBe(0);
  });

  // M3: snapshotProjectForSync + syncWholeProjectDiff — Open file / New project
  it('syncWholeProjectDiff emits bpm, patternLength, mixer.volume, and step note (M3)', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    const before = mod.snapshotProjectForSync();
    synth.project.bpm = 150;
    synth.project.tracks[0].patternLength = 32;
    synth.project.tracks[1].mixer.volume = 0.3;
    synth.project.tracks[0].steps[0].note = 'C';
    mod.syncWholeProjectDiff(before);
    vi.advanceTimersByTime(50); // bpm and mixer.volume are throttled
    const bpmOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['bpm']));
    expect(bpmOp?.value).toBe(150);
    const plOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength']));
    expect(plOp?.value).toBe(32);
    const volOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']));
    expect(volOp?.value).toBeCloseTo(0.3);
    const noteOp = fake.sent.find((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 0, 'note']));
    expect(noteOp?.value).toBe('C');
    // No engine params changed in this test, so nothing under 'engines' should be
    // emitted. The synth2 matrix array is still deferred to Task 3's watcher.
    for (const o of fake.sent) {
      expect((o.path as string[]).includes('engines')).toBe(false);
      expect((o.path as string[]).includes('matrix')).toBe(false);
    }
  });

  it('syncWholeProjectDiff emits nothing when snapshot matches live (M3 regression)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    const before = mod.snapshotProjectForSync();
    fake.sent.length = 0;
    mod.syncWholeProjectDiff(before);
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(0);
  });

  // --- Phase 2b-iii new tests ---

  it('engine param edit via dispatch emits exactly one op (no double-emit)', async () => {
    const { mod, fake } = await bootWithFakeSocket();
    fake.sent.length = 0;
    mod.dispatchLocal(['tracks', 0, 'engines', 'synth2', 'filter', 'cutoff'], 3000);
    vi.advanceTimersByTime(50);
    const ops = fake.sent.filter((o: any) => o.path.join('.') === 'tracks.0.engines.synth2.filter.cutoff');
    expect(ops).toHaveLength(1);
    expect(ops[0].value).toBe(3000);
  });

  it('applyPreset emits the changed engine-slice params', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    const before = { ...(synth.project.tracks[0].engines.kick as Record<string, unknown>) };
    // simulate the StudioView flow: mutate the slice then call the diff emitter
    (synth.project.tracks[0].engines.kick as any).tune = 99;
    fake.sent.length = 0;
    mod.syncEngineParamsDiff(0, 'kick', before);
    vi.advanceTimersByTime(50);
    expect(fake.sent.some((o: any) => o.path.join('.') === 'tracks.0.engines.kick.tune' && o.value === 99)).toBe(true);
  });

  it('whole-project diff emits engine-slice param changes (Open/New)', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    const snap = mod.snapshotProjectForSync();
    (synth.project.tracks[0].engines.synth2 as any).osc1.morph = 2.5;
    fake.sent.length = 0;
    mod.syncWholeProjectDiff(snap);
    vi.advanceTimersByTime(50);
    expect(fake.sent.some((o: any) => o.path.join('.') === 'tracks.0.engines.synth2.osc1.morph' && o.value === 2.5)).toBe(true);
  });

  it('whole-project diff emits matrix leaf changes (Open/New)', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    const snap = mod.snapshotProjectForSync();
    (synth.project.tracks[0].engines.synth2 as any).matrix[0].amount = 0.5;
    fake.sent.length = 0;
    mod.syncWholeProjectDiff(snap);
    vi.advanceTimersByTime(50);
    expect(fake.sent.some((o: any) => o.path.join('.') === 'tracks.0.engines.synth2.matrix.0.amount' && o.value === 0.5)).toBe(true);
  });

  it('syncEngineParamsDiff emits synth2 matrix changes (preset load / INIT PATCH)', async () => {
    const { mod, synth, fake } = await bootWithFakeSocket();
    // Simulate the applyPresetSynced / onInitPatch flow: snapshot the slice, mutate
    // a matrix route in place, then emit the diff. Guards the array-skip footgun:
    // emitLeafDiff drops arrays, so without the emitMatrixDiff drill this is silent.
    const before = mod.cloneEngineSlice(synth.project.tracks[0].engines.synth2 as any);
    (synth.project.tracks[0].engines.synth2 as any).matrix[2].dest = 'filter.cutoff';
    (synth.project.tracks[0].engines.synth2 as any).matrix[2].amount = 0.7;
    fake.sent.length = 0;
    mod.syncEngineParamsDiff(0, 'synth2', before);
    vi.advanceTimersByTime(50);
    expect(fake.sent.some((o: any) => o.path.join('.') === 'tracks.0.engines.synth2.matrix.2.dest' && o.value === 'filter.cutoff')).toBe(true);
    expect(fake.sent.some((o: any) => o.path.join('.') === 'tracks.0.engines.synth2.matrix.2.amount' && o.value === 0.7)).toBe(true);
  });
});

describe('session-scoped connection', () => {
  function makeFakeWsClient(opts: any) {
    let seq = 0;
    return {
      _opts: opts, sent: [] as any[],
      connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
      send(op: any) { this.sent.push(op); },
      isLive: () => true, nextClientSeq: () => ++seq,
      recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn(),
      getPersisted: () => null,
    };
  }

  let pushState: ReturnType<typeof vi.fn>;
  let replaceState: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pushState = vi.fn();
    replaceState = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { pushState, replaceState }, addEventListener: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });

  async function boot() {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    const built: any[] = [];
    mod.setWsClientFactory((o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; });
    mod.setSyncEnabled(true);
    mod.disposeSynth();
    const synth = mod.useSynth();
    return { mod, synth, built };
  }

  it('connectToSession builds + connects a socket for the room and tracks currentRoomId', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    expect(built).toHaveLength(1);
    expect(built[0]._opts.roomId).toBe('room-a');
    expect(built[0].connect).toHaveBeenCalledTimes(1);
    expect(synth.currentRoomId.value).toBe('room-a');
  });

  it('toggles roomLoading: true while catching up, false on sync.complete', async () => {
    const { mod, synth, built } = await boot();
    expect(synth.roomLoading.value).toBe(false); // lobby — nothing loading
    mod.connectToSession('room-a');
    expect(synth.roomLoading.value).toBe(true); // connect → loader on

    // Snapshot alone doesn't clear it (a resumed connection has no snapshot);
    // the loader stays until the room reaches live on sync.complete.
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    expect(synth.roomLoading.value).toBe(true);

    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    expect(synth.roomLoading.value).toBe(false); // caught up → loader off
  });

  it('clears roomLoading on leaveSession', async () => {
    const { mod, synth } = await boot();
    mod.connectToSession('room-a');
    expect(synth.roomLoading.value).toBe(true);
    mod.leaveSession();
    expect(synth.roomLoading.value).toBe(false);
  });

  it('exposes a passive sessionName ref defaulting to null', () => {
    const synth = useSynth();
    expect(synth.sessionName.value).toBeNull();
  });

  it('is idempotent for the same room', async () => {
    const { mod, built } = await boot();
    mod.connectToSession('room-a');
    mod.connectToSession('room-a');
    expect(built).toHaveLength(1);
  });

  it('re-opening the room you are already in does not push a duplicate history entry', async () => {
    const { mod } = await boot();
    mod.connectToSession('room-a', { history: 'push' });
    expect(pushState).toHaveBeenCalledTimes(1);
    expect(pushState).toHaveBeenCalledWith(null, '', '/r/room-a');
    // A no-op re-connect to the same room (e.g. clicking its lobby card again)
    // must not grow history with a second /r/room-a entry — otherwise browser
    // Back lands back on the studio instead of the previous page.
    mod.connectToSession('room-a', { history: 'push' });
    expect(pushState).toHaveBeenCalledTimes(1);
  });

  it('switching rooms disconnects the old socket and builds a new one', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    mod.connectToSession('room-b');
    expect(built).toHaveLength(2);
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(built[1]._opts.roomId).toBe('room-b');
    expect(synth.currentRoomId.value).toBe('room-b');
  });

  it('leaveSession disconnects, clears currentRoomId, and resets the project', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    synth.project.bpm = 199;
    mod.leaveSession();
    expect(built[0].disconnect).toHaveBeenCalled();
    expect(synth.currentRoomId.value).toBeNull();
    expect(synth.project.bpm).toBe(120); // fresh project default
  });

  // --- Cross-session state-bleed guards ---
  // These pin the two-part fix: (1) the local project is reset on every room
  // switch, and (2) outbound sync is gated until the room's snapshot lands, so
  // stale / pre-load content can never be written up into the room.

  it('resets the local project when switching rooms (no stale content carries over)', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    const snap = freshProject();
    snap.bpm = 200;
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: snap });
    expect(synth.project.bpm).toBe(200); // room-a content applied

    mod.connectToSession('room-b');
    // Before any room-b snapshot, room-a's content must be gone (reset to fresh).
    expect(synth.project.bpm).toBe(120);
  });

  it('does not emit local edits until the room sync completes', async () => {
    const { mod, synth, built } = await boot();
    await synth.ensureAudio(); // installs the sync watchers
    mod.connectToSession('room-a');

    // Edit BEFORE catch-up completes — must not leak to the room (gate closed),
    // even after the snapshot has been applied.
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    mod.dispatchLocal(['tracks', 0, 'patternLength'], 8);
    expect(built[0].sent.length).toBe(0);

    // sync.complete → gate opens.
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    mod.dispatchLocal(['tracks', 0, 'patternLength'], 5); // discrete → flushes immediately
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
  it('emits edits made before the first Play (sync does not require ensureAudio/audio)', async () => {
    const { mod, built } = await boot();
    // NOTE: deliberately NO ensureAudio() — simulates editing before pressing Play.
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    built[0].sent.length = 0; // ignore any catch-up ops

    // The exact repro: swap an engine before any AudioContext exists. engineType is
    // discrete (gestureEnd) so it flushes immediately — no timer advance needed.
    mod.dispatchLocal(['tracks', 0, 'engineType'], 'kick');

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
    const { mod, synth, built } = await boot();
    await synth.ensureAudio(); // installs the sync watchers
    mod.connectToSession('room-a');

    // Resume/replay handshake: backfilled `set` ops, then sync.complete — never a
    // snapshot message.
    built[0]._opts.onMessage({
      v: 1, type: 'set', opId: 1, clientId: 'other', path: ['bpm'], value: 140,
    });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 1 });

    mod.dispatchLocal(['tracks', 0, 'patternLength'], 6); // discrete → flushes immediately
    expect(
      built[0].sent.some((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength'])),
    ).toBe(true);
  });

  it('does not flush the previous room\'s content into the new room on switch', async () => {
    const { mod, synth, built } = await boot();
    await synth.ensureAudio(); // installs the sync watchers
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    mod.dispatchLocal(['tracks', 0, 'patternLength'], 7); // legit edit to room-a
    expect(built[0].sent.length).toBeGreaterThan(0);

    mod.connectToSession('room-b');
    // Gate closed + project reset: no ops to room-b before it syncs, even if
    // a reactive change fires.
    expect(built[1].sent.length).toBe(0);
    mod.dispatchLocal(['tracks', 0, 'patternLength'], 3);
    expect(built[1].sent.length).toBe(0);

    // After room-b syncs, edits flow to room-b again.
    built[1]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[1]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    mod.dispatchLocal(['tracks', 0, 'patternLength'], 9);
    expect(
      built[1].sent.some((o: any) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'patternLength'])),
    ).toBe(true);
  });
});

describe('variable track count', () => {
  // Reuse the same fake-socket harness shape as the session-scoped suite: the
  // fake records outbound ops in `sent` and drives inbound via `_opts.onMessage`.
  function makeFakeWsClient(opts: any) {
    let seq = 0;
    return {
      _opts: opts, sent: [] as any[],
      connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
      send(op: any) { this.sent.push(op); },
      isLive: () => true, nextClientSeq: () => ++seq,
      recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn(),
      getPersisted: () => null,
    };
  }

  let bootedMod: any = null;

  beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { replaceState: vi.fn() }, addEventListener: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });

  // Settle this test's fade-dispose timers while ITS module instance is still
  // current — the next test's resetModules would strand them, and they'd fire
  // after another suite unstubs the AudioNode global.
  afterEach(() => { bootedMod?.disposeSynth(); bootedMod = null; });

  async function boot() {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    const built: any[] = [];
    mod.setWsClientFactory((o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; });
    mod.setSyncEnabled(true);
    mod.disposeSynth();
    const synth = mod.useSynth();
    await synth.ensureAudio(); // installs the per-track sync watchers
    bootedMod = mod;
    return { mod, synth, built };
  }

  it('addTrack enables the lowest-index disabled slot and emits a leaf op', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    built[0].sent.length = 0; // clear ops emitted during catch-up

    synth.addTrack();
    await nextTick();

    expect(synth.project.tracks[4].enabled).toBe(true);
    expect(synth.enabledTrackCount.value).toBe(5);
    expect(
      built[0].sent.some((m: any) => m.path.join('.') === 'tracks.4.enabled' && m.value === true),
    ).toBe(true);
  });

  it('removeTrack disables that slot but refuses to drop below 1 enabled', async () => {
    const { mod, synth, built } = await boot();
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });

    synth.removeTrack(3);
    await nextTick();
    expect(synth.project.tracks[3].enabled).toBe(false);
    expect(synth.enabledTrackCount.value).toBe(3);

    synth.removeTrack(2);
    synth.removeTrack(1);
    await nextTick();
    expect(synth.enabledTrackCount.value).toBe(1);
    synth.removeTrack(0);
    await nextTick();
    expect(synth.enabledTrackCount.value).toBe(1); // unchanged — refused
    expect(synth.project.tracks[0].enabled).toBe(true);
  });

  it('exposes all TRACK_POOL_SIZE slots in project.tracks', async () => {
    const { synth } = await boot();
    expect(synth.project.tracks).toHaveLength(TRACK_POOL_SIZE);
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
    vi.resetModules();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('boots a fresh project, ignoring an old fiddle:project key', async () => {
    const seed = { schemaVersion: 1, bpm: 144, tracks: [{}, {}, {}, {}] };
    lsStore.set('fiddle:project', JSON.stringify(seed));

    const { useSynth: useSynthFresh } = await import('../composables/useSynth');
    const synth = useSynthFresh();
    expect(synth.project.bpm).toBe(120); // fresh, not the stored 144
    expect(lsImpl.getItem).not.toHaveBeenCalled();
  });

  it('does not autosave mutations to localStorage', async () => {
    vi.useFakeTimers();
    const { useSynth: useSynthFresh } = await import('../composables/useSynth');
    const synth = useSynthFresh();
    synth.project.tracks[0].engines.synth.filterCutoff = 5678;
    await Promise.resolve();
    vi.advanceTimersByTime(1000); // past the old 500ms debounce
    vi.useRealTimers();

    expect(lsImpl.setItem).not.toHaveBeenCalled();
  });
});

describe('focused-track URL view-state', () => {
  let pushState: ReturnType<typeof vi.fn>;
  let replaceState: ReturnType<typeof vi.fn>;

  function makeFakeWsClient(opts: any) {
    let seq = 0;
    return {
      _opts: opts, sent: [] as any[],
      connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
      send: vi.fn(), isLive: () => true, nextClientSeq: () => ++seq,
      recordOpIdSeen: vi.fn(), opIdLastSeen: vi.fn(() => 0), requestResync: vi.fn(),
      getPersisted: () => null,
    };
  }

  beforeEach(() => {
    pushState = vi.fn();
    replaceState = vi.fn();
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { pushState, replaceState }, addEventListener: vi.fn() });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/' });
  });
  afterEach(() => vi.unstubAllGlobals());

  async function boot() {
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
    const mod = await import('./useSynth');
    mod.setWsClientFactory((o: any) => makeFakeWsClient(o) as any);
    mod.setSyncEnabled(true);
    mod.disposeSynth();
    const synth = mod.useSynth();
    return { mod, synth };
  }

  it('selectTrack(n) opens the editor: pushes ?t=<n> (Back returns to overview) and focuses the track', async () => {
    const { mod, synth } = await boot();
    mod.connectToSession('room-a'); // module fn: sets currentRoomId without touching the view
    synth.selectTrack(2);
    expect(pushState).toHaveBeenCalledWith(null, '', '/r/room-a?t=2');
    expect(synth.activeTrackIndex.value).toBe(2);
  });

  it('selectTrack(null) leaves the editor: replaces with the bare room URL and shows the overview', async () => {
    const { mod, synth } = await boot();
    mod.connectToSession('room-a');
    synth.selectTrack(2);
    synth.selectTrack(null);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/r/room-a');
    expect(synth.activeTrackIndex.value).toBeNull();
  });

  it('setFocusedTrack(n) syncs the view from the URL without a new history entry (popstate path)', async () => {
    const { mod, synth } = await boot();
    mod.connectToSession('room-a');
    synth.setFocusedTrack(3);
    expect(replaceState).toHaveBeenLastCalledWith(null, '', '/r/room-a?t=3');
    expect(pushState).not.toHaveBeenCalled();
    expect(synth.activeTrackIndex.value).toBe(3);
  });

  it('entering a session resets a stale editor view to the overview (kills cross-session bleed-through)', async () => {
    const { mod, synth } = await boot();
    mod.connectToSession('room-a');
    synth.selectTrack(2);
    expect(synth.activeTrackIndex.value).toBe(2);
    synth.connectToSession('room-b'); // wrapped composable fn → resets the view
    expect(synth.activeTrackIndex.value).toBeNull();
  });

  it('leaving a session resets the editor view to the overview', async () => {
    const { mod, synth } = await boot();
    mod.connectToSession('room-a');
    synth.selectTrack(2);
    synth.leaveSession(); // wrapped composable fn → resets the view
    expect(synth.activeTrackIndex.value).toBeNull();
  });

  it('selectTrack with no active room only sets the view (no URL write)', async () => {
    const { synth } = await boot();
    synth.selectTrack(1);
    expect(synth.activeTrackIndex.value).toBe(1);
    expect(pushState).not.toHaveBeenCalled();
    expect(replaceState).not.toHaveBeenCalled();
  });
});
