// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WavetableOscillator } from './WavetableOscillator';

class MockAudioParam {
  setValueAtTime = vi.fn();
}
class MockAudioBuffer {
  duration: number;
  private data: Float32Array;
  constructor(public numberOfChannels: number, public length: number, public sampleRate: number) {
    this.duration = length / sampleRate;
    this.data = new Float32Array(length);
  }
  getChannelData(_ch: number) { return this.data; }
}
class MockBufferSourceNode {
  buffer: MockAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new MockAudioParam();
  detune = new MockAudioParam();
  start = vi.fn();
  stop = vi.fn();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockGainNode {
  gain = new MockAudioParam();
  connect = vi.fn();
  disconnect = vi.fn();
}
class MockAudioContext {
  currentTime = 0;
  sampleRate = 48000;
  createBuffer(numChan: number, len: number, sr: number) { return new MockAudioBuffer(numChan, len, sr); }
  createBufferSource = vi.fn().mockImplementation(() => new MockBufferSourceNode());
  createGain() { return new MockGainNode(); }
}
vi.stubGlobal('AudioContext', MockAudioContext);

beforeEach(() => {
  // Bank is class-level; reset between tests so ensureBank logic is testable.
  (WavetableOscillator as any).bank = null;
  (WavetableOscillator as any).bankSampleRate = 0;
});

describe('WavetableOscillator', () => {
  it('ensureBank builds four buffers on first call and is a no-op on the second', () => {
    const ctx = new (AudioContext as any)();
    const spy = vi.spyOn(ctx, 'createBuffer');
    WavetableOscillator.ensureBank(ctx);
    const callsAfterFirst = spy.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(4); // 4 base waveforms + maybe 'custom' alias
    WavetableOscillator.ensureBank(ctx);
    expect(spy.mock.calls.length).toBe(callsAfterFirst); // singleton: no further calls
  });

  it('sine buffer sample 0 is approximately 0 and quarter-buffer is approximately 1', () => {
    const ctx = new (AudioContext as any)();
    const bank = WavetableOscillator.ensureBank(ctx);
    const sineData = bank.sine.getChannelData(0);
    expect(Math.abs(sineData[0] - 0)).toBeLessThan(1e-3);
    expect(Math.abs(sineData[Math.floor(sineData.length / 4)] - 1)).toBeLessThan(1e-3);
  });

  it('triggerAt creates a BufferSource with the right buffer, playbackRate, start offset, and stop time', () => {
    const ctx = new (AudioContext as any)();
    const osc = new WavetableOscillator(ctx);
    osc.setWaveform('sine');
    osc.setPhase(90);
    osc.triggerAt(440, 0, 1.0);

    expect(ctx.createBufferSource).toHaveBeenCalledTimes(1);
    const src = ctx.createBufferSource.mock.results[0].value as any;

    // playbackRate = 440 / (sampleRate / BUFFER_LENGTH) = 440 / (48000 / 2048)
    const expectedRate = 440 / (48000 / 2048);
    expect(src.playbackRate.setValueAtTime).toHaveBeenCalledWith(expectedRate, 0);

    // start(time, offset) with offset = (90/360) * bufferDuration
    const bufferDuration = 2048 / 48000;
    const expectedOffset = (90 / 360) * bufferDuration;
    const startCall = src.start.mock.calls[0];
    expect(startCall[0]).toBe(0);
    expect(Math.abs((startCall[1] as number) - expectedOffset)).toBeLessThan(1e-9);

    expect(src.stop).toHaveBeenCalledWith(1.05);
  });

  it('coarseTune is folded into playbackRate', () => {
    const ctx = new (AudioContext as any)();
    const osc = new WavetableOscillator(ctx);
    osc.setCoarseTune(1); // +1 octave
    osc.triggerAt(440, 0, 1.0);
    const src = ctx.createBufferSource.mock.results[0].value as any;
    const expectedRate = 880 / (48000 / 2048);
    expect(src.playbackRate.setValueAtTime).toHaveBeenCalledWith(expectedRate, 0);
  });
});
