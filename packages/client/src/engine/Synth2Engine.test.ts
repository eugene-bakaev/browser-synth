import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Synth2Engine } from './Synth2Engine';
import { SYNTH2_DESCRIPTORS, DEFAULT_SYNTH2_PARAMS } from '@fiddle/shared';
import { PARAM_INDEX } from './synth2/kernel/params';

class MockPort {
  posted: any[] = [];
  postMessage = vi.fn((msg: any) => { this.posted.push(msg); });
}

class MockAudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
}

class MockWorkletNode extends MockAudioNode {
  port = new MockPort();
  constructor(public ctx: unknown, public name: string, public options: unknown) { super(); }
}

class MockGainNode extends MockAudioNode {
  gain = { value: 1 };
}

function mockCtx() {
  return {
    state: 'running',
    currentTime: 0,
    destination: new MockAudioNode(),
    resume: vi.fn(),
    createGain: () => new MockGainNode(),
  } as unknown as AudioContext;
}

beforeEach(() => {
  vi.stubGlobal('AudioWorkletNode', MockWorkletNode);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastNode(engine: Synth2Engine): MockWorkletNode {
  return (engine as any).node as MockWorkletNode;
}

describe('Synth2Engine protocol', () => {
  it('registers as engineType synth2 and builds a synth2 worklet node', () => {
    const engine = new Synth2Engine(mockCtx());
    expect(engine.engineType).toBe('synth2');
    expect(lastNode(engine).name).toBe('synth2');
  });

  it('applyParams maps nested sparse params onto descriptor indices and posts the block', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ osc1: { morph: 1.5 }, env1: { r: 2 } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.type).toBe('params');
    expect(msg.block[PARAM_INDEX['osc1.morph']]).toBeCloseTo(1.5);
    expect(msg.block[PARAM_INDEX['env1.r']]).toBeCloseTo(2);
    // untouched leaves stay at defaults
    expect(msg.block[PARAM_INDEX['osc1.level']]).toBeCloseTo(DEFAULT_SYNTH2_PARAMS.osc1.level);
  });

  it('applyParams with no effective change posts nothing', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams(structuredClone(DEFAULT_SYNTH2_PARAMS) as any);
    expect(lastNode(engine).port.posted.filter(m => m.type === 'params')).toHaveLength(0);
  });

  it('applyParams accepts the full slice shape (descriptor coverage)', () => {
    const engine = new Synth2Engine(mockCtx());
    const slice = structuredClone(DEFAULT_SYNTH2_PARAMS) as any;
    for (const d of SYNTH2_DESCRIPTORS) {
      const [mod, field] = d.key.split('.');
      slice[mod][field] = d.min;
    }
    engine.applyParams(slice);
    const msg = lastNode(engine).port.posted.at(-1);
    for (const d of SYNTH2_DESCRIPTORS) {
      expect(msg.block[PARAM_INDEX[d.key]], d.key).toBeCloseTo(d.min);
    }
  });

  it('trigger posts a single mono message for a scalar freq', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.trigger(440, 0.5, 1.25, 0.8);
    const posted = lastNode(engine).port.posted.filter(m => m.type === 'trigger');
    expect(posted).toEqual([
      { type: 'trigger', time: 1.25, freq: 440, duration: 0.5, velocity: 0.8, mono: true },
    ]);
  });

  it('trigger fans a chord to one poly message per note', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.trigger([220, 330, 440], 0.5, 1.25, 0.8);
    const posted = lastNode(engine).port.posted.filter(m => m.type === 'trigger');
    expect(posted).toEqual([
      { type: 'trigger', time: 1.25, freq: 220, duration: 0.5, velocity: 0.8, mono: false },
      { type: 'trigger', time: 1.25, freq: 330, duration: 0.5, velocity: 0.8, mono: false },
      { type: 'trigger', time: 1.25, freq: 440, duration: 0.5, velocity: 0.8, mono: false },
    ]);
  });

  it('dispose posts dispose and disconnects', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.dispose();
    expect(lastNode(engine).port.posted.at(-1)).toEqual({ type: 'dispose' });
    expect(lastNode(engine).disconnect).toHaveBeenCalled();
  });
});
