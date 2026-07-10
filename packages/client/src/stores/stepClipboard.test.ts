import { describe, it, expect, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { reactive } from 'vue';
import { freshStep, type Step } from '@fiddle/shared';
import { useStepClipboardStore } from './stepClipboard';

describe('step clipboard store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('starts empty', () => {
    expect(useStepClipboardStore().rows).toBeNull();
  });

  it('set stores plain deep copies — later source mutations do not leak in', () => {
    const clip = useStepClipboardStore();
    const source = reactive<Step[]>([{ ...freshStep(), note: 'C', velocity: 0.5 }]);
    clip.set(source);
    source[0].note = 'G';
    source[0].velocity = 1;
    expect(clip.rows![0].note).toBe('C');
    expect(clip.rows![0].velocity).toBe(0.5);
  });

  it('copies the full row shape', () => {
    const clip = useStepClipboardStore();
    const step: Step = { note: 'E', octave: 5, length: 3, velocity: 0.7, muted: true, isChord: true, chordType: 'min' };
    clip.set([step]);
    expect(clip.rows![0]).toEqual(step);
  });
});
