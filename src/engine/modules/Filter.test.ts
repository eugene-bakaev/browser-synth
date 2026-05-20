import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FilterModule } from './Filter';

class AudioNode {
  connect() {}
  disconnect() {}
}
class AudioParam {}

class MockBiquadFilterNode extends AudioNode {
  type = 'lowpass';
  frequency = new AudioParam();
}

class AudioContext {
  createBiquadFilter() {
    return new MockBiquadFilterNode();
  }
}

vi.stubGlobal('AudioNode', AudioNode);
vi.stubGlobal('AudioParam', AudioParam);
vi.stubGlobal('AudioContext', AudioContext);

describe('FilterModule', () => {
  let ctx: AudioContext;

  beforeEach(() => {
    ctx = new AudioContext();
  });

  it('should implement Module interface', () => {
    const filter = new FilterModule(ctx as any);
    expect(filter.name).toBe('Filter');
    expect(filter.inputs).toHaveProperty('main');
    expect(filter.inputs).toHaveProperty('cutoff');
    expect(filter.outputs).toHaveProperty('main');
  });

  it('should initialize with lowpass filter', () => {
    const filter = new FilterModule(ctx as any);
    // @ts-ignore - accessing private filter for testing
    expect(filter.filter.type).toBe('lowpass');
  });
});
