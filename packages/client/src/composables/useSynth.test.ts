import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';

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
      send(op: any) { this.sent.push(op); },
      isLive: () => true,
      nextClientSeq: () => ++seq,
      recordOpIdSeen: vi.fn(),
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
    return { mod, synth, fake: fake! };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // buildSyncState resolves the room from window.location and builds a ws://
    // URL from location — stub both for the node test env.
    vi.stubGlobal('window', {
      location: { pathname: '/r/testroom1' },
      history: { replaceState: vi.fn() },
    });
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173', pathname: '/r/testroom1' });
  });
  afterEach(() => { vi.useRealTimers(); });

  it('emits a leaf op to the socket when a synth param changes', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].engines.synth.filterCutoff = 1234;
    vi.advanceTimersByTime(50); // clear the 50ms throttle window
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'engines', 'synth', 'filterCutoff']);
    expect(fake.sent[0].value).toBe(1234);
  });

  it('drills nested ADSR edits to leaf paths (no whole-object writes)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].engines.synth.filterEnv.a = 0.123;
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

  it('rolls back the local value on nack', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].engines.synth.filterCutoff = 1500;
    vi.advanceTimersByTime(50);
    expect(fake.sent.length).toBe(1);
    const clientSeq = fake.sent[0].clientSeq;
    fake._opts.onMessage({
      v: 1, type: 'nack', clientSeq, code: 'value.invalid', message: 'too high',
    });
    expect(synth.project.tracks[0].engines.synth.filterCutoff).toBe(2000); // default restored
  });

  it('emits engineType swaps immediately (discrete)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].engineType = 'kick';
    // No timer advance: discrete selection flushes immediately (gestureEnd).
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'engineType']));
    expect(op).toBeDefined();
    expect(op.value).toBe('kick');
  });

  it('emits mixer volume (throttled) and muted (immediate) as leaf ops', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[1].mixer.muted = true; // toggle → immediate
    const mutedOp = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'muted']));
    expect(mutedOp?.value).toBe(true);

    synth.project.tracks[1].mixer.volume = 0.5; // slider → throttled
    expect(fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']))).toBeUndefined();
    vi.advanceTimersByTime(50);
    const volOp = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 1, 'mixer', 'volume']));
    expect(volOp?.value).toBe(0.5);
  });

  it('emits a step edit as a leaf op', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].steps[3].note = 'C'; // discrete → immediate
    const op = fake.sent.find((o) => JSON.stringify(o.path) === JSON.stringify(['tracks', 0, 'steps', 3, 'note']));
    expect(op).toBeDefined();
    expect(op.value).toBe('C');
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
});

describe('Project boot integration', () => {
  // The vitest environment (node/jsdom-less) has no real localStorage — stub one.
  let lsStore: Map<string, string>;
  const lsImpl = {
    getItem: (k: string) => lsStore.has(k) ? lsStore.get(k)! : null,
    setItem: (k: string, v: string) => { lsStore.set(k, v); },
    removeItem: (k: string) => { lsStore.delete(k); },
    clear: () => { lsStore.clear(); },
  };

  beforeEach(() => {
    lsStore = new Map();
    vi.stubGlobal('localStorage', lsImpl);
    try { localStorage.removeItem('fiddle:project'); } catch {}
    vi.resetModules();
  });

  afterEach(() => { vi.unstubAllGlobals(); });

  it('loads a seeded V1 project from localStorage on first useSynth call', async () => {
    const seed = {
      schemaVersion: 1 as const,
      bpm: 144,
      tracks: [/* 4 partial tracks — reconciler fills in defaults */
        { engineType: 'synth', engines: { synth: { filterCutoff: 1234 } } },
        {}, {}, {},
      ],
    };
    localStorage.setItem('fiddle:project', JSON.stringify(seed));

    const { useSynth: useSynthFresh } = await import('../composables/useSynth');
    const synth = useSynthFresh();
    expect(synth.project.bpm).toBe(144);
    expect(synth.project.tracks[0].engines.synth.filterCutoff).toBe(1234);
  });

  it('persists a knob mutation to localStorage after debounce', async () => {
    vi.useFakeTimers();
    const { useSynth: useSynthFresh } = await import('../composables/useSynth');
    const synth = useSynthFresh();
    synth.project.tracks[0].engines.synth.filterCutoff = 5678;
    await Promise.resolve();
    vi.advanceTimersByTime(500);
    vi.useRealTimers();

    const raw = localStorage.getItem('fiddle:project');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.tracks[0].engines.synth.filterCutoff).toBe(5678);
  });
});
