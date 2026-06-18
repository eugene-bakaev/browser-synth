import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Synth2Engine } from './Synth2Engine';
import { SYNTH2_DESCRIPTORS, DEFAULT_SYNTH2_PARAMS, MOD_SOURCES } from '@fiddle/shared';
import { PARAM_INDEX, MATRIX_BASE, MATRIX_STRIDE } from './synth2/kernel/params';

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

describe('Synth2Engine boolean (discrete) params', () => {
  it('encodes osc2.sync=true as 1 in the posted block', () => {
    const engine = new Synth2Engine(mockCtx());
    const port = lastNode(engine).port;
    port.posted.length = 0;

    engine.applyParams({ osc2: { sync: true } });

    const msg = port.posted.find((m: any) => m.type === 'params');
    expect(msg).toBeTruthy();
    expect(msg.block[PARAM_INDEX['osc2.sync']]).toBe(1);
  });

  it('encodes osc2.sync=false as 0 and is a no-op when already 0', () => {
    const engine = new Synth2Engine(mockCtx());
    const port = lastNode(engine).port;
    port.posted.length = 0;
    // Default sync is 0; setting false again should not post.
    engine.applyParams({ osc2: { sync: false } });
    expect(port.posted.some((m: any) => m.type === 'params')).toBe(false);
    // Flip true then false: the false flip posts a 0.
    engine.applyParams({ osc2: { sync: true } });
    port.posted.length = 0;
    engine.applyParams({ osc2: { sync: false } });
    const msg = port.posted.find((m: any) => m.type === 'params');
    expect(msg).toBeTruthy();
    expect(msg.block[PARAM_INDEX['osc2.sync']]).toBe(0);
  });

  it('ignores string params (mode rides the trigger, not the block)', () => {
    const engine = new Synth2Engine(mockCtx());
    const port = lastNode(engine).port;
    port.posted.length = 0;
    engine.applyParams({ mode: 'poly' } as any);
    expect(port.posted.some((m: any) => m.type === 'params')).toBe(false);
  });

  it('skips a string-valued field that has a valid param index (inner else-continue)', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = lastNode(engine).port;
    port.posted.length = 0;
    engine.applyParams({ osc2: { morph: 'x' } } as any);
    expect(port.posted.some(m => m.type === 'params')).toBe(false);
  });

  it('encodes env1.loop=true as 1 in the posted block (I3c)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ env1: { loop: true } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.block[PARAM_INDEX['env1.loop']]).toBe(1);
  });

  it('encodes an env3 ADSR leaf onto its descriptor index (I3c)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ env3: { a: 1.5 } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.block[PARAM_INDEX['env3.a']]).toBeCloseTo(1.5);
  });
});

describe('Synth2Engine enum (filter.type) params', () => {
  it('encodes filter.type by index (hp → 2, lp → 0)', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = lastNode(engine).port;
    port.posted.length = 0;

    engine.applyParams({ filter: { type: 'hp' } });
    let msg = port.posted.find((m: any) => m.type === 'params');
    expect(msg.block[PARAM_INDEX['filter.type']]).toBe(2);

    port.posted.length = 0;
    engine.applyParams({ filter: { type: 'lp' } });
    msg = port.posted.find((m: any) => m.type === 'params');
    expect(msg.block[PARAM_INDEX['filter.type']]).toBe(0);
  });

  it('does not repost when the enum value is unchanged', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = lastNode(engine).port;
    engine.applyParams({ filter: { type: 'bp' } });
    port.posted.length = 0;
    engine.applyParams({ filter: { type: 'bp' } });
    expect(port.posted.some((m: any) => m.type === 'params')).toBe(false);
  });

  it('encodes filter.morph (continuous) and filter.model (enum index) into the block (I3d)', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = lastNode(engine).port;
    port.posted.length = 0;

    engine.applyParams({ filter: { morph: 2, model: 'morph' } });
    const msg = port.posted.find((m: any) => m.type === 'params');
    expect(msg.block[PARAM_INDEX['filter.morph']]).toBeCloseTo(2, 6);
    expect(msg.block[PARAM_INDEX['filter.model']]).toBe(1); // enumValues.indexOf('morph')
  });

  it('still ignores the top-level mode string (rides the trigger, not the block)', () => {
    const ctx = mockCtx();
    const engine = new Synth2Engine(ctx);
    const port = lastNode(engine).port;
    port.posted.length = 0;
    engine.applyParams({ mode: 'poly' } as any);
    expect(port.posted.some((m: any) => m.type === 'params')).toBe(false);
  });
});

describe('Synth2Engine matrix encoding (I3a)', () => {
  it('encodes a matrix route into the block (source idx, dest+1, amount) (I3a)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({
      matrix: [
        { source: 'env1', dest: 'filter.cutoff', amount: 0.5 },
        ...Array.from({ length: 7 }, () => ({ source: 'none', dest: 'none', amount: 0 })),
      ],
    });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.type).toBe('params');
    expect(msg.block[MATRIX_BASE]).toBe(MOD_SOURCES.indexOf('env1'));           // slot 0 source
    expect(msg.block[MATRIX_BASE + 1]).toBe(PARAM_INDEX['filter.cutoff'] + 1); // dest encoded (+1)
    expect(msg.block[MATRIX_BASE + 2]).toBeCloseTo(0.5, 6);                    // amount
  });

  it('encodes dest = none as 0 (I3a)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({
      matrix: [
        { source: 'lfo1', dest: 'none', amount: 0.9 },
        ...Array.from({ length: 7 }, () => ({ source: 'none', dest: 'none', amount: 0 })),
      ],
    });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.block[MATRIX_BASE + 1]).toBe(0);
  });

  it('does not repost when the same matrix route is applied twice (Float32 dirty-check) (I3a)', () => {
    const engine = new Synth2Engine(mockCtx());
    const port = lastNode(engine).port;
    const route = {
      matrix: [
        { source: 'env1', dest: 'filter.cutoff', amount: 0.5 },
        ...Array.from({ length: 7 }, () => ({ source: 'none', dest: 'none', amount: 0 })),
      ],
    };
    // First apply — must post (block changes from zero-init).
    engine.applyParams(route);
    const countAfterFirst = port.posted.filter((m: any) => m.type === 'params').length;
    expect(countAfterFirst).toBeGreaterThan(0);
    // Second apply with identical values — dirty-check must suppress the post.
    engine.applyParams(route);
    const countAfterSecond = port.posted.filter((m: any) => m.type === 'params').length;
    expect(countAfterSecond).toBe(countAfterFirst);
  });

  it('encodes lfo leaves into the param block via the descriptor walk (I3b)', () => {
    const engine = new Synth2Engine(mockCtx());
    engine.applyParams({ lfo1: { rate: 12, shape: 2 }, lfo2: { rate: 3 } });
    const msg = lastNode(engine).port.posted.at(-1);
    expect(msg.type).toBe('params');
    expect(msg.block[PARAM_INDEX['lfo1.rate']]).toBeCloseTo(12);
    expect(msg.block[PARAM_INDEX['lfo1.shape']]).toBeCloseTo(2);
    expect(msg.block[PARAM_INDEX['lfo2.rate']]).toBeCloseTo(3);
    // untouched lfo leaf stays at its default
    expect(msg.block[PARAM_INDEX['lfo2.shape']]).toBeCloseTo(DEFAULT_SYNTH2_PARAMS.lfo2.shape);
  });
});
