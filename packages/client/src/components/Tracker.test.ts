// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, type App } from 'vue';
import Tracker from './Tracker.vue';
import { freshStep } from '../project';
import { DEFAULT_MIXER_STATE } from '../project';

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
