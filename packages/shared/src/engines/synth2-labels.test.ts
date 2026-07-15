import { describe, it, expect } from 'vitest';
import {
  SYNTH2_MODULE_LABELS, SYNTH2_ENV_ROLES, MOD_SOURCE_LABELS, modDestLabel, knobLabel,
} from './synth2-labels.js';
import { SYNTH2_DESCRIPTORS, MOD_SOURCES, MOD_DESTS } from './synth2-descriptors.js';

describe('MOD_SOURCE_LABELS', () => {
  it('labels every wire source (spec vocabulary)', () => {
    expect(MOD_SOURCE_LABELS).toEqual({
      none: 'None', lfo1: 'LFO 1', lfo2: 'LFO 2',
      env1: 'Env 1 (Amp)', env2: 'Env 2 (Filter)', env3: 'Env 3 (Mod)',
      velocity: 'Velocity', noise: 'Noise',
    });
    for (const s of MOD_SOURCES) expect(MOD_SOURCE_LABELS[s]).toBeTruthy();
  });

  it('composes env source labels from SYNTH2_ENV_ROLES (role written once)', () => {
    expect(SYNTH2_ENV_ROLES).toEqual({ env1: 'Amp', env2: 'Filter', env3: 'Mod' });
    expect(MOD_SOURCE_LABELS.env1).toBe(`Env 1 (${SYNTH2_ENV_ROLES.env1})`);
  });
});

describe('modDestLabel', () => {
  it('maps none and composes module prefix + param label', () => {
    expect(modDestLabel('none')).toBe('None');
    expect(modDestLabel('osc1.coarse')).toBe('Osc 1 Octave');
    expect(modDestLabel('osc3.fine')).toBe('Osc 3 Detune');
    expect(modDestLabel('filter.resonance')).toBe('Filter Res');
    expect(modDestLabel('env2.a')).toBe('Env 2 Attack');
    expect(modDestLabel('lfo1.rate')).toBe('LFO 1 Rate');
    expect(modDestLabel('noise.color')).toBe('Noise Color');
  });

  it('renders the fm rows with no module prefix', () => {
    expect(SYNTH2_MODULE_LABELS.fm).toBeNull();
    expect(modDestLabel('fm.osc2')).toBe('FM 1→2');
    expect(modDestLabel('fm.osc3')).toBe('FM 2→3');
  });

  it('gives every MOD_DESTS entry a friendly label distinct from the raw key', () => {
    for (const dest of MOD_DESTS) {
      const label = modDestLabel(dest);
      expect(label, dest).toBeTruthy();
      expect(label, dest).not.toBe(dest);
      expect(label, dest).not.toContain('.');
    }
  });

  it('never renders two dests identically (collision guard, incl. prefix-less FM)', () => {
    const labels = MOD_DESTS.map(modDestLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('falls back to the raw key for unknown keys (defensive; old client vs newer data)', () => {
    expect(modDestLabel('future.param')).toBe('future.param');
  });
});

describe('knobLabel', () => {
  it('prefers shortLabel (env stages) and falls back to label', () => {
    expect(knobLabel('env1.a')).toBe('A');
    expect(knobLabel('env3.r')).toBe('R');
    expect(knobLabel('osc1.coarse')).toBe('Octave');
    expect(knobLabel('fm.osc2')).toBe('FM 1→2');
  });

  it('covers every descriptor module with a SYNTH2_MODULE_LABELS entry', () => {
    for (const d of SYNTH2_DESCRIPTORS) {
      const mod = d.key.split('.')[0];
      expect(SYNTH2_MODULE_LABELS[mod], d.key).not.toBeUndefined();
    }
  });
});
