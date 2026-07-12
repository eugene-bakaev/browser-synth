// @vitest-environment jsdom
// jsdom (not the default node env) so `new KeyboardEvent(...)` in the
// undo/redo wiring tests below is a real constructor — same pattern as
// keyboard/KeyboardService.test.ts and keyboard/trackerCommands.test.ts.
import { describe, it, expect, vi } from 'vitest';
import { createAppRuntime } from './AppRuntime';
import { detectPlatform } from '../keyboard/keys';
import { freshProject } from '../project';

// Minimal Web Audio mock (same shape as AudioEngine.test / useSynth.test) —
// createAppRuntime builds an AudioEngine, whose ensureAudio()/togglePlay() touch
// AudioContext transitively.
class MockAudioNode { connect = vi.fn(); disconnect = vi.fn(); context = { currentTime: 0 }; }
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
  frequency = new MockAudioParam(); detune = new MockAudioParam(); type = 'sine';
  start = vi.fn(); stop = vi.fn();
}
class MockBiquadFilterNode extends MockAudioNode { frequency = new MockAudioParam(); Q = new MockAudioParam(); type = 'lowpass'; }
class MockDynamicsCompressorNode extends MockAudioNode {
  threshold = new MockAudioParam(); knee = new MockAudioParam(); ratio = new MockAudioParam();
  attack = new MockAudioParam(); release = new MockAudioParam();
}
class MockAnalyserNode extends MockAudioNode { fftSize = 1024; }
class MockAudioWorkletNode extends MockAudioNode {
  parameters = new Map<string, MockAudioParam>([
    ['frequency', new MockAudioParam()], ['detune', new MockAudioParam()], ['pulseWidth', new MockAudioParam()],
  ]);
}
class MockAudioContext {
  state = 'suspended'; currentTime = 0; sampleRate = 44100;
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

// A fake WsClient matching the surface SyncSession/messageDispatch touch. The
// factory captures opts so a test could push server messages via opts.onMessage.
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

// window/location stubs: connect() computes a ws URL from `location` and installs
// a beforeunload handler on `window`. removeEventListener is needed too: shutdown()
// now disposes a KeyboardService, which removes its window keydown listener.
function stubEnv() {
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:5173' });
}

describe('AppRuntime', () => {
  it('bootstrap builds a working core; shutdown stops the transport, closes the ctx and socket; second shutdown is a no-op', async () => {
    stubEnv();
    const built: any[] = [];
    const runtime = createAppRuntime({
      wsClientFactory: (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    });
    // state writes flow: bus → store
    runtime.bus.dispatchLocal({ path: ['bpm'], value: 141 });
    expect(runtime.store.project.bpm).toBe(141);

    await runtime.audio.ensureAudio();
    await runtime.audio.togglePlay();
    expect(runtime.audio.sequencer.isPlaying).toBe(true);
    runtime.session.connect('room-x');
    expect(built).toHaveLength(1);

    runtime.shutdown();
    expect(runtime.audio.sequencer.isPlaying).toBe(false);       // transport stopped
    expect(runtime.audio.trackGains.value).toBeNull();           // ctx torn down
    expect(built[0].disconnect).toHaveBeenCalled();              // socket closed
    expect(runtime.session.isConnected).toBe(false);

    runtime.shutdown();                                          // idempotent
    expect(built[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('two runtimes are fully isolated (per-page project)', () => {
    const a = createAppRuntime({ syncEnabled: false });
    const b = createAppRuntime({ syncEnabled: false });
    a.bus.dispatchLocal({ path: ['bpm'], value: 150 });
    expect(a.store.project.bpm).toBe(150);
    expect(b.store.project.bpm).not.toBe(150);
    expect(a.store.project).not.toBe(b.store.project);
  });

  it('the runtime survives shutdown: audio re-boots and a room re-connects (bfcache restore path)', async () => {
    stubEnv();
    const built: any[] = [];
    const runtime = createAppRuntime({
      wsClientFactory: (o: any) => { const f = makeFakeWsClient(o); built.push(f); return f as any; },
    });
    await runtime.audio.ensureAudio();
    runtime.session.connect('room-x');
    runtime.shutdown();
    await runtime.audio.ensureAudio();                            // rebuilds from null
    expect(runtime.audio.trackGains.value).not.toBeNull();
    runtime.session.connect('room-x');
    expect(built).toHaveLength(2);                                // fresh socket
    runtime.shutdown();
  });
});

describe('undo/redo wiring', () => {
  // jsdom's platform varies by host OS — derive the expected mod key the same
  // way the KeyboardService does, so the test passes on mac and linux CI alike.
  const mod = () => (detectPlatform() === 'mac' ? { metaKey: true } : { ctrlKey: true });

  it('mod+z undoes and shift+mod+z redoes a local edit end-to-end', async () => {
    const rt = createAppRuntime({ syncEnabled: false });
    const prior = rt.store.project.bpm;
    rt.bus.dispatchLocal({ path: ['bpm'], value: prior + 8, priorValue: prior, gestureEnd: true });
    await Promise.resolve(); // seal the burst entry
    rt.keyboard.handleKeydown(new KeyboardEvent('keydown', { key: 'z', ...mod() }));
    expect(rt.store.project.bpm).toBe(prior);
    rt.keyboard.handleKeydown(new KeyboardEvent('keydown', { key: 'z', shiftKey: true, ...mod() }));
    expect(rt.store.project.bpm).toBe(prior + 8);
    rt.shutdown();
  });

  it('undo restores route through the bus (outbound enqueue observed)', async () => {
    const rt = createAppRuntime({ syncEnabled: false });
    const enqueued: unknown[] = [];
    const spy = vi.spyOn(rt.session, 'enqueue').mockImplementation(((...args: unknown[]) => { enqueued.push(args); }) as never);
    const prior = rt.store.project.bpm;
    rt.bus.dispatchLocal({ path: ['bpm'], value: prior + 8, priorValue: prior, gestureEnd: true });
    await Promise.resolve();
    rt.history.undo();
    expect(rt.store.project.bpm).toBe(prior);
    expect(enqueued.length).toBe(2); // the edit AND the restore both sync
    spy.mockRestore();
    rt.shutdown();
  });

  it('loadProject clears the history', async () => {
    const rt = createAppRuntime({ syncEnabled: false });
    rt.bus.dispatchLocal({ path: ['bpm'], value: 99, priorValue: rt.store.project.bpm, gestureEnd: true });
    await Promise.resolve();
    expect(rt.history.canUndo()).toBe(true);
    rt.bus.loadProject(freshProject());
    expect(rt.history.canUndo()).toBe(false);
    expect(rt.history.canRedo()).toBe(false);
    rt.shutdown();
  });
});
