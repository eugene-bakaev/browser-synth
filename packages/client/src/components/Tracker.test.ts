// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, type App } from 'vue';
import Tracker from './Tracker.vue';
import { freshStep } from '../project';
import { DEFAULT_MIXER_STATE } from '../project';
import { SYNTH_CONTEXT, type SynthContext } from '../app/synthContext';

// Tracker takes dispatchLocal/endGesture off the injected synth context
// (Phase 5); these layout tests never write, so a minimal fake suffices.
const fakeSynth = { dispatchLocal: vi.fn(), endGesture: vi.fn() } as unknown as SynthContext;

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mountTracker(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(Tracker, props);
  app.provide(SYNTH_CONTEXT, fakeSynth);
  app.mount(host);
  return host;
}

function makeSteps(n = 4) {
  return Array.from({ length: n }, () => freshStep());
}

const BASE_PROPS = {
  currentStep: -1,
  title: 'T1',
  color: '#00f0ff',
  isFocused: false,
  trackId: 0,
  patternLength: 4,
  canRemove: false,
  mixer: { ...DEFAULT_MIXER_STATE },
};

describe('Tracker isPoly computed', () => {
  it('synth2 + mode:poly renders chord-row layout (ROOT/CHORD columns)', () => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'synth2',
      mode: 'poly',
    });
    // The header row gets .chord-row when isPoly is true
    expect(el.querySelector('.tracker-header.chord-row')).not.toBeNull();
    // And the ROOT / CHORD column headers are present
    const headers = [...el.querySelectorAll('.tracker-header div')].map(d => d.textContent?.trim());
    expect(headers).toContain('ROOT');
    expect(headers).toContain('CHORD');
  });

  it('synth2 + mode:mono renders single-note layout (NOTE column, no CHORD)', () => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'synth2',
      mode: 'mono',
    });
    // Header uses .synth-row (not .chord-row) for mono melodic
    expect(el.querySelector('.tracker-header.chord-row')).toBeNull();
    expect(el.querySelector('.tracker-header.synth-row')).not.toBeNull();
    const headers = [...el.querySelectorAll('.tracker-header div')].map(d => d.textContent?.trim());
    expect(headers).toContain('NOTE');
    expect(headers).not.toContain('CHORD');
  });

  it('synth + mode:poly still renders chord-row layout', () => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'synth',
      mode: 'poly',
    });
    expect(el.querySelector('.tracker-header.chord-row')).not.toBeNull();
  });

  it('drum engine ignores mode and renders trig layout', () => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'kick',
      mode: 'poly', // mode is irrelevant for non-melodic engines
    });
    expect(el.querySelector('.tracker-header.drum-row')).not.toBeNull();
    expect(el.querySelector('.tracker-header.chord-row')).toBeNull();
  });
});

describe('note select empty placeholder', () => {
  // A `:value` binding coerces null to "" on the <select>, so the placeholder
  // option must carry value="" to match — otherwise an empty step renders a
  // blank select (selectedIndex -1) instead of the "---" marker.
  it.each(['mono', 'poly'] as const)('null note shows the --- option selected (%s)', (mode) => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(), // freshStep() → note: null
      engineType: 'synth',
      mode,
    });
    const select = el.querySelector<HTMLSelectElement>('.col-note select')!;
    expect(select).not.toBeNull();
    expect(select.selectedIndex).toBe(0);
    expect(select.options[select.selectedIndex].text).toBe('---');
  });
});
