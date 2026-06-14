import { describe, it, expect } from 'vitest';
import { PARAM_COUNT, MATRIX_BASE, MATRIX_SLOTS, MATRIX_STRIDE, BLOCK_LENGTH, defaultParamBlock } from './params.js';

describe('matrix block region (I3a)', () => {
  it('appends an 8×3 matrix region after the descriptor params', () => {
    expect(MATRIX_SLOTS).toBe(8);
    expect(MATRIX_STRIDE).toBe(3);
    expect(MATRIX_BASE).toBe(PARAM_COUNT);
    expect(BLOCK_LENGTH).toBe(PARAM_COUNT + 24);
  });

  it('default block has the descriptor defaults then an all-zero matrix region', () => {
    const b = defaultParamBlock();
    expect(b.length).toBe(BLOCK_LENGTH);
    for (let i = MATRIX_BASE; i < BLOCK_LENGTH; i++) expect(b[i]).toBe(0);
  });
});
