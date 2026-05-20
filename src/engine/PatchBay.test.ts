import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PatchBay } from './PatchBay';

// Mock Web Audio API classes for Node environment
class AudioNode {
  connect() {}
  disconnect() {}
}
class AudioParam {}

class MockGainNode extends AudioNode {
  connect = vi.fn();
  disconnect = vi.fn();
  gain = new AudioParam();
}

class AudioContext {
  createGain() {
    return new MockGainNode();
  }
}

vi.stubGlobal('AudioNode', AudioNode);
vi.stubGlobal('AudioParam', AudioParam);
vi.stubGlobal('AudioContext', AudioContext);

describe('PatchBay', () => {
  let patchBay: PatchBay;
  let ctx: AudioContext;

  beforeEach(() => {
    patchBay = new PatchBay();
    ctx = new AudioContext();
  });

  it('should connect an AudioNode to another AudioNode', () => {
    const source = ctx.createGain();
    const target = ctx.createGain();
    const connectSpy = vi.spyOn(source, 'connect');
    
    patchBay.connect(source as any, target as any);
    
    expect(connectSpy).toHaveBeenCalledWith(target);
  });

  it('should connect an AudioNode to an AudioParam', () => {
    const source = ctx.createGain();
    const target = ctx.createGain().gain;
    const connectSpy = vi.spyOn(source, 'connect');
    
    patchBay.connect(source as any, target as any);
    
    expect(connectSpy).toHaveBeenCalledWith(target);
  });

  it('should throw an error if source is not an AudioNode', () => {
    const source = ctx.createGain().gain as any;
    const target = ctx.createGain();
    
    expect(() => patchBay.connect(source, target as any)).toThrow("Source must be an AudioNode to connect to a target.");
  });

  it('should disconnect an AudioNode from another AudioNode', () => {
    const source = ctx.createGain();
    const target = ctx.createGain();
    const disconnectSpy = vi.spyOn(source, 'disconnect');
    
    patchBay.disconnect(source as any, target as any);
    
    expect(disconnectSpy).toHaveBeenCalledWith(target);
  });
});
