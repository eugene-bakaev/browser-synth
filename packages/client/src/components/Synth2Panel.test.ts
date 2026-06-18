// @vitest-environment jsdom
import { describe, it, expect, afterEach } from 'vitest';
import { createApp, type App } from 'vue';
import Synth2Panel from './Synth2Panel.vue';
import { Synth2Engine } from '../engine/Synth2Engine';

let app: App | null = null;
let host: HTMLElement | null = null;

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

  it('toggles mode to poly on POLY click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btns = el.querySelectorAll<HTMLButtonElement>('.mode-btn');
    btns[1].click(); // POLY
    expect(params.mode).toBe('poly');
  });

  it('toggles mode back to mono on MONO click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.mode = 'poly';
    const el = mountPanel(params);
    const btns = el.querySelectorAll<HTMLButtonElement>('.mode-btn');
    btns[0].click(); // MONO
    expect(params.mode).toBe('mono');
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

  it('toggles osc2.sync on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    expect(params.osc2.sync).toBe(false);
    syncBtns[0].click();
    expect(params.osc2.sync).toBe(true);
    syncBtns[0].click();
    expect(params.osc2.sync).toBe(false);
  });

  it('toggles osc3.sync on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const syncBtns = el.querySelectorAll<HTMLButtonElement>('.sync-btn');
    syncBtns[1].click();
    expect(params.osc3.sync).toBe(true);
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

  it('clicking HP sets params.filter.type', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const typeBtns = el.querySelectorAll<HTMLButtonElement>('.filter-type-btn');
    expect(params.filter.type).toBe('lp');
    typeBtns[2].click();
    expect(params.filter.type).toBe('hp');
    typeBtns[1].click();
    expect(params.filter.type).toBe('bp');
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

  it('the CLASSIC|MORPH toggle updates params.filter.model', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(params.filter.model).toBe('classic');
    const toMorph = el.querySelector<HTMLButtonElement>('.filter-model-btn.to-morph')!;
    toMorph.click();
    expect(params.filter.model).toBe('morph');
    const toClassic = el.querySelector<HTMLButtonElement>('.filter-model-btn.to-classic')!;
    toClassic.click();
    expect(params.filter.model).toBe('classic');
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

  it('toggles env1.loop and env3.loop via the LOOP buttons', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    // DOM order follows column order: [0] AMP ENV (env1), [1] FILTER ENV (env2), [2] ENV 3 (env3).
    const loopBtns = el.querySelectorAll<HTMLButtonElement>('.loop-btn');
    expect(params.env1.loop).toBe(false);
    loopBtns[0].click();
    expect(params.env1.loop).toBe(true);
    loopBtns[2].click();
    expect(params.env3.loop).toBe(true);
  });
});
