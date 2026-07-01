// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { createApp, ref, type App } from 'vue';
import Synth2Panel from './Synth2Panel.vue';
import { Synth2Engine } from '../engine/Synth2Engine';
import { ACTIVE_TRACK_KEY } from '../sync/knobSync';

// Panel controls now route writes through the command bus (dispatchLocal), not
// direct params mutation. Partial-mock useSynth so we can assert the dispatched
// op; every other export (endGesture, touchedFor read by Knob, …) stays real so
// the panel and its child Knobs still mount and render normally.
vi.mock('../composables/useSynth', async (orig) => {
  const actual = await orig<typeof import('../composables/useSynth')>();
  return { ...actual, dispatchLocal: vi.fn() };
});
import { dispatchLocal } from '../composables/useSynth';

// Wire path for the focused synth2 track (mountPanel provides active track 0).
const SYN2 = (...tail: (string | number)[]) => ['tracks', 0, 'engines', 'synth2', ...tail];

let app: App | null = null;
let host: HTMLElement | null = null;

beforeEach(() => { (dispatchLocal as unknown as Mock).mockClear(); });

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mountPanel(params: object): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(Synth2Panel, { params, analyser: null, color: '#fff' });
  app.provide(ACTIVE_TRACK_KEY, ref(0));
  app.mount(host);
  return host;
}

describe('Synth2Panel mode toggle', () => {
  it('renders two mode buttons', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btns = el.querySelectorAll<HTMLButtonElement>('.mode-btn');
    expect(btns.length).toBe(2);
    expect(btns[0].textContent?.trim()).toBe('MONO');
    expect(btns[1].textContent?.trim()).toBe('POLY');
  });

  it('dispatches mode poly on POLY click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btns = el.querySelectorAll<HTMLButtonElement>('.mode-btn');
    btns[1].click(); // POLY
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('mode'), 'poly');
  });

  it('dispatches mode mono on MONO click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.mode = 'poly';
    const el = mountPanel(params);
    const btns = el.querySelectorAll<HTMLButtonElement>('.mode-btn');
    btns[0].click(); // MONO
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('mode'), 'mono');
  });
});

describe('Synth2Panel osc2/osc3/noise/fm controls', () => {
  it('renders osc2/osc3/noise/fm controls', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const text = (el.textContent || '').toUpperCase();
    expect(text).toContain('OSC 2');
    expect(text).toContain('OSC 3');
    expect(text).toContain('NOISE');
    expect(text).toContain('FM');
  });
});

describe('Synth2Panel hard-sync toggles', () => {
  it('renders a SYNC toggle on osc2 and osc3 (not osc1)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    expect(syncBtns.length).toBe(2); // osc2 + osc3 only
  });

  it('dispatches osc2.sync toggled on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    expect(params.osc2.sync).toBe(false);
    syncBtns[0].click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('osc2', 'sync'), true);
  });

  it('dispatches osc3.sync toggled on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    syncBtns[1].click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('osc3', 'sync'), true);
  });
});

describe('Synth2Panel filter section', () => {
  it('renders the LP/BP/HP type selector and a cutoff knob', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const typeBtns = el.querySelectorAll<HTMLButtonElement>('.filter-type-btn');
    expect(typeBtns.length).toBe(3);
    expect([...typeBtns].map(b => b.textContent?.trim())).toEqual(['LP', 'BP', 'HP']);
  });

  it('clicking HP/BP dispatches params.filter.type', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const typeBtns = el.querySelectorAll<HTMLButtonElement>('.filter-type-btn');
    expect(params.filter.type).toBe('lp');
    typeBtns[2].click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('filter', 'type'), 'hp');
    typeBtns[1].click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('filter', 'type'), 'bp');
  });

  it('renders a Drive knob in the filter column', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const modelSelector = el.querySelector('.filter-model-selector')!;
    const filterGroup = modelSelector.closest('.module-group')!;
    const labels = Array.from(filterGroup.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels).toContain('Drive');
  });
});

describe('Synth2Panel filter model toggle (I3d)', () => {
  it('classic model shows the LP/BP/HP selector and no Morph knob in the filter column', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    expect(params.filter.model).toBe('classic');
    const el = mountPanel(params);
    expect(el.querySelector('.filter-type-selector')).not.toBeNull();
    const modelSelector = el.querySelector('.filter-model-selector')!;
    const filterGroup = modelSelector.closest('.module-group')!;
    const labels = Array.from(filterGroup.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels).not.toContain('Morph');
  });

  it('morph model hides the type selector and shows a Morph knob bound to params.filter.morph', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.filter.model = 'morph';
    const el = mountPanel(params);
    expect(el.querySelector('.filter-type-selector')).toBeNull();
    const modelSelector = el.querySelector('.filter-model-selector')!;
    const filterGroup = modelSelector.closest('.module-group')!;
    const labels = Array.from(filterGroup.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels).toContain('Morph');
  });

  it('the CLASSIC|MORPH toggle dispatches params.filter.model', () => {
    // dispatch is mocked so params.filter.model never flips locally (the toggle
    // button therefore keeps its target); mount each direction separately.
    const classic = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    expect(classic.filter.model).toBe('classic');
    const el1 = mountPanel(classic);
    el1.querySelector<HTMLButtonElement>('.filter-model-btn.to-morph')!.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('filter', 'model'), 'morph');

    (dispatchLocal as unknown as Mock).mockClear();
    app?.unmount(); host?.remove();
    const morph = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    morph.filter.model = 'morph';
    const el2 = mountPanel(morph);
    el2.querySelector<HTMLButtonElement>('.filter-model-btn.to-classic')!.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('filter', 'model'), 'classic');
  });

  it('an un-healed old snapshot (filter.model/morph missing) renders the classic selector without crashing', () => {
    // Regression: a pre-I3d snapshot reaching the panel before heal had model
    // undefined → the old `=== 'classic'` v-if fell through to the morph branch,
    // whose Morph knob then read filter.morph (undefined) and threw in Knob.
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    delete params.filter.model;
    delete params.filter.morph;
    const el = mountPanel(params); // must not throw
    expect(el.querySelector('.filter-type-selector')).not.toBeNull(); // defaults to classic
    const modelSelector = el.querySelector('.filter-model-selector')!;
    const filterGroup = modelSelector.closest('.module-group')!;
    const labels = Array.from(filterGroup.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels).not.toContain('Morph');
  });
});

describe('Synth2Panel mod matrix (I3a)', () => {
  it('renders 8 matrix rows', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.querySelectorAll('.matrix-row').length).toBe(8);
  });

  it('updates a route source via the select', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const sel = el.querySelector<HTMLSelectElement>('.matrix-row .matrix-source')!;
    sel.value = 'env1';
    sel.dispatchEvent(new Event('change')); // v-model on <select> listens to 'change'
    expect(params.matrix[0].source).toBe('env1');
  });

  it('updates a route dest via the select', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const sel = el.querySelector<HTMLSelectElement>('.matrix-row .matrix-dest')!;
    sel.value = 'filter.cutoff';
    sel.dispatchEvent(new Event('change')); // v-model on <select> listens to 'change'
    expect(params.matrix[0].dest).toBe('filter.cutoff');
  });

  it('each matrix row has an amount knob (8 total)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    // Knob renders <div class="knob"> with <label class="knob-label"> inside.
    // Selecting .matrix-row .knob-label elements whose text is "Amt" is the
    // most robust signal: it simultaneously verifies the Knob is present AND
    // that our label="Amt" prop change rendered correctly.
    const amtLabels = el.querySelectorAll<HTMLLabelElement>('.matrix-row .knob-label');
    expect(amtLabels.length).toBe(8);
    amtLabels.forEach(lbl => expect(lbl.textContent?.trim()).toBe('Amt'));
  });
});

describe('Synth2Panel LFO column (I3b)', () => {
  it('renders LFO1 + LFO2 rate/shape knobs', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const labels = Array.from(el.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels.filter((l) => l === 'Rate')).toHaveLength(2);
    expect(labels.filter((l) => l === 'Shape')).toHaveLength(2);
  });
});

describe('Synth2Panel envelope loop + ENV 3 (I3c)', () => {
  it('renders the ENV 3 column', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect((el.textContent || '').toUpperCase()).toContain('ENV 3');
  });

  it('renders a LOOP toggle on AMP ENV, FILTER ENV, and ENV 3 (3 total)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const loopBtns = el.querySelectorAll<HTMLButtonElement>('.loop-btn');
    expect(loopBtns.length).toBe(3);
  });

  it('dispatches env1.loop and env3.loop via the LOOP buttons', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    // DOM order follows column order: [0] AMP ENV (env1), [1] FILTER ENV (env2), [2] ENV 3 (env3).
    const loopBtns = el.querySelectorAll<HTMLButtonElement>('.loop-btn');
    expect(params.env1.loop).toBe(false);
    loopBtns[0].click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('env1', 'loop'), true);
    loopBtns[2].click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('env3', 'loop'), true);
  });
});

describe('Synth2Panel wave previews (2026-06-19)', () => {
  it('renders exactly five wave previews (osc1/2/3 + lfo1/2)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.querySelectorAll('.wave-preview').length).toBe(5);
  });

  it('places a wave preview inside each osc and LFO module group (and nowhere else)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const headingsWithPreview = Array.from(el.querySelectorAll('.module-group'))
      .filter((g) => g.querySelector('.wave-preview'))
      .map((g) => g.querySelector('h3')?.textContent?.trim())
      .sort();
    expect(headingsWithPreview).toEqual(['LFO 1', 'LFO 2', 'OSC 1', 'OSC 2', 'OSC 3']);
  });
});
