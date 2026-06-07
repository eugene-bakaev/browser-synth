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

  it('emits a patternLength op immediately (discrete — no timer needed)', async () => {
    const { fake, synth } = await bootWithFakeSocket();
    synth.project.tracks[0].patternLength = 8;
    // No timer advance: patternLength is in DISCRETE_LEAF_FIELDS → flushes immediately.
    expect(fake.sent.length).toBe(1);
    expect(fake.sent[0].path).toEqual(['tracks', 0, 'patternLength']);
    expect(fake.sent[0].value).toBe(8);
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
});

describe('session-scoped connection', () => {
  function makeFakeWsClient(opts: any) {
    let seq = 0;
    return {
      _opts: opts, sent: [] as any[],
      connect: vi.fn(), disconnect: vi.fn(), reconnect: vi.fn(),
      send(op: any) { this.sent.push(op); },
      isLive: () => true, nextClientSeq: () => ++seq,
      recordOpIdSeen: vi.fn(), getPersisted: () => null,
    };
  }

  beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { replaceState: vi.fn() } });
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

  it('is idempotent for the same room', async () => {
    const { mod, built } = await boot();
    mod.connectToSession('room-a');
    mod.connectToSession('room-a');
    expect(built).toHaveLength(1);
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
    synth.project.tracks[0].patternLength = 8;
    expect(built[0].sent.length).toBe(0);

    // sync.complete → gate opens.
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    synth.project.tracks[0].patternLength = 5; // discrete → flushes immediately
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
    const { mod, synth, built } = await boot();
    // NOTE: deliberately NO ensureAudio() — simulates editing before pressing Play.
    mod.connectToSession('room-a');
    built[0]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[0]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    built[0].sent.length = 0; // ignore any catch-up ops

    // The exact repro: swap an engine before any AudioContext exists. engineType is
    // discrete (gestureEnd) so it flushes immediately — no timer advance needed.
    synth.project.tracks[0].engineType = 'kick';

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

    synth.project.tracks[0].patternLength = 6; // discrete → flushes immediately
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
    synth.project.tracks[0].patternLength = 7; // legit edit to room-a
    expect(built[0].sent.length).toBeGreaterThan(0);

    mod.connectToSession('room-b');
    // Gate closed + project reset: no ops to room-b before it syncs, even if
    // a reactive change fires.
    expect(built[1].sent.length).toBe(0);
    synth.project.tracks[0].patternLength = 3;
    expect(built[1].sent.length).toBe(0);

    // After room-b syncs, edits flow to room-b again.
    built[1]._opts.onMessage({ v: 1, type: 'snapshot', opId: 0, project: freshProject() });
    built[1]._opts.onMessage({ v: 1, type: 'sync.complete', opId: 0 });
    synth.project.tracks[0].patternLength = 9;
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
      recordOpIdSeen: vi.fn(), getPersisted: () => null,
    };
  }

  beforeEach(() => {
    vi.stubGlobal('window', { location: { pathname: '/' }, history: { replaceState: vi.fn() } });
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
    await synth.ensureAudio(); // installs the per-track sync watchers
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
