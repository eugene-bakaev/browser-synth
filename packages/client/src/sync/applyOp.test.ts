import { describe, it, expect } from 'vitest';
import { isApplyingFromNetwork, enterSuppress, exitSuppress } from './applyOp.js';

describe('suppression flag', () => {
  it('defaults to not-applying', () => {
    expect(isApplyingFromNetwork()).toBe(false);
  });

  it('enterSuppress sets it and exitSuppress clears it', () => {
    enterSuppress();
    expect(isApplyingFromNetwork()).toBe(true);
    exitSuppress();
    expect(isApplyingFromNetwork()).toBe(false);
  });
});
