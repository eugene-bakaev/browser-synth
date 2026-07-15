import { describe, it, expect } from 'vitest';
import { gestureEndForLeaf } from './dispatchPolicy';

describe('gestureEndForLeaf', () => {
  it('trackOrder is a discrete action (immediate flush, no undo drag-merge)', () => {
    expect(gestureEndForLeaf('trackOrder')).toBe(true);
  });
  it('continuous leaves stay continuous', () => {
    expect(gestureEndForLeaf('volume')).toBe(false);
  });
});
