// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeEach, vi, type Mock } from 'vitest';
import { createApp, ref, type App } from 'vue';
import Synth2Panel from './Synth2Panel.vue';
import { Synth2Engine } from '../engine/Synth2Engine';
import { ACTIVE_TRACK_KEY } from '../sync/knobSync';
import { SYNTH_CONTEXT } from '../app/synthContext';

// Panel controls route writes through the injected synth context's dispatchLocal
// (via useKnobSync). Provide a minimal fake context so we can assert the
// dispatched op; the panel and its child Knobs still mount and render normally.
const dispatchLocal = vi.fn();
const fakeSynth = { dispatchLocal, endGesture: vi.fn() } as unknown as import('../app/synthContext').SynthContext;

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
  app.provide(SYNTH_CONTEXT, fakeSynth);
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

  it('dispatches a route source change via the select', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const sel = el.querySelector<HTMLSelectElement>('.matrix-row .matrix-source')!;
    sel.value = 'env1';
    sel.dispatchEvent(new Event('change'));
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('matrix', 0, 'source'), 'env1');
  });

  it('dispatches a route dest change via the select', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const sel = el.querySelector<HTMLSelectElement>('.matrix-row .matrix-dest')!;
    sel.value = 'filter.cutoff';
    sel.dispatchEvent(new Event('change'));
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('matrix', 0, 'dest'), 'filter.cutoff');
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

describe('Synth2Panel oscillator pitch (2026-07-12 octave + detune)', () => {
  it('renders an Octave and a Detune knob for each of the 3 oscillators', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const labels = Array.from(el.querySelectorAll<HTMLLabelElement>('.knob-label'))
      .map((n) => n.textContent?.trim());
    expect(labels.filter((l) => l === 'Octave')).toHaveLength(3);
    expect(labels.filter((l) => l === 'Detune')).toHaveLength(3);
    // Old labels are gone.
    expect(labels).not.toContain('Coarse');
    expect(labels).not.toContain('Fine');
  });

  it('binds each Octave/Detune knob to its OWN oscillator (no cross-osc leak)', () => {
    // Distinct per-osc values so a copy-paste path leak (e.g. osc2's Octave bound
    // to osc1.coarse) surfaces as a wrong readout in DOM order. The Octave knob's
    // 'octaveSwitch' readout = round(coarse/12) signed; Detune's 'cents' = `${fine}c`.
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.osc1.coarse = 12;  params.osc1.fine = 100;   // +1 / +100c
    params.osc2.coarse = 24;  params.osc2.fine = -600;  // +2 / -600c
    params.osc3.coarse = 36;  params.osc3.fine = 1200;  // +3 / +1200c
    const el = mountPanel(params);
    // A knob's readout (.knob-value) renders straight from its bound modelValue.
    const readoutFor = (label: string) =>
      Array.from(el.querySelectorAll<HTMLElement>('.knob'))
        .filter((k) => k.querySelector('.knob-label')?.textContent?.trim() === label)
        .map((k) => k.querySelector('.knob-value')?.textContent?.trim());
    expect(readoutFor('Octave')).toEqual(['+1', '+2', '+3']);
    expect(readoutFor('Detune')).toEqual(['+100c', '-600c', '+1200c']);
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

describe('Synth2Panel LFO tempo-sync', () => {
  it('renders a SYNC toggle on lfo1 and lfo2', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const lfoSyncBtns = el.querySelectorAll<HTMLButtonElement>('.lfo-sync-btn');
    expect(lfoSyncBtns.length).toBe(2);
  });

  it('dispatches lfo1.sync toggled true on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btn = el.querySelectorAll<HTMLButtonElement>('.lfo-sync-btn')[0];
    expect(params.lfo1.sync).toBe(false);
    btn.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('lfo1', 'sync'), true);
  });

  it('shows the division label on the Rate knob when synced', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.lfo1.sync = true;
    params.lfo1.div = '1/8';
    const el = mountPanel(params);
    // The synced LFO1 Rate knob readout shows the division, not a Hz value.
    expect(el.textContent).toContain('1/8');
  });

  it('renders the LFO mode control and dispatches lfo1.mode on S&H click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const seg = el.querySelector('.lfo-mode-selector');
    expect(seg).not.toBeNull();
    const buttons = seg!.querySelectorAll<HTMLButtonElement>('.lfo-mode-btn');
    expect(buttons.length).toBe(3); // OFF / S&H / SMOOTH
    buttons[1].click(); // S&H
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('lfo1', 'mode'), 's&h');
  });
});

describe('Synth2Panel envelope tempo-sync', () => {
  it('renders one SYNC toggle per envelope, distinct from LFO and osc sync buttons', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    expect(el.querySelectorAll<HTMLButtonElement>('.env-sync-btn').length).toBe(3);
    expect(el.querySelectorAll<HTMLButtonElement>('.lfo-sync-btn').length).toBe(2); // unchanged
    expect(el.querySelectorAll<HTMLButtonElement>('.sync-btn').length).toBe(2);     // unchanged
  });

  it('dispatches env1.sync toggled true on click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const btn = el.querySelectorAll<HTMLButtonElement>('.env-sync-btn')[0];
    expect(params.env1.sync).toBe(false);
    btn.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('env1', 'sync'), true);
  });

  it('shows step-division labels on A/D/R when synced while S stays a percent knob', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.sync = true;
    params.env1.aDiv = '2/3';  // distinctive step labels that appear nowhere else
    params.env1.dDiv = '1/6';
    params.env1.rDiv = '3/4';
    const el = mountPanel(params);
    expect(el.textContent).toContain('2/3 st');
    expect(el.textContent).toContain('1/6 st');
    expect(el.textContent).toContain('3/4 st');
    expect(el.textContent).toContain('50%'); // env1.s default 0.5 still renders as percent
  });

  it('free mode still shows time readouts (no division labels)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.aDiv = '2/3'; // distinctive; must stay hidden while free
    const el = mountPanel(params);
    expect(el.textContent).not.toContain('2/3');
  });

  it('env knobs use step labels while LFO Rate keeps note-division labels', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.env1.sync = true;
    params.env1.aDiv = '1/6';   // step label — not in the LFO vocabulary
    params.lfo1.sync = true;
    params.lfo1.div = '1/8.';   // dotted note label — not in the env vocabulary
    const el = mountPanel(params);
    expect(el.textContent).toContain('1/6 st');
    expect(el.textContent).toContain('1/8.');
  });
});

describe('Synth2Panel glide (portamento) control', () => {
  it('renders the Glide knob and SYNC toggle in their own GLIDE module panel', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    const cell = el.querySelector('.module-group.glide-panel');
    expect(cell).not.toBeNull();
    expect(cell!.querySelector('h3')!.textContent?.trim()).toBe('GLIDE');
    const labels = Array.from(cell!.querySelectorAll('.knob-label')).map(n => n.textContent?.trim());
    expect(labels).toContain('Glide');
    expect(cell!.querySelector('.glide-sync-btn')!.textContent?.trim()).toBe('SYNC');
  });

  it('dispatches glide.sync on SYNC click', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    const el = mountPanel(params);
    el.querySelector<HTMLButtonElement>('.glide-sync-btn')!.click();
    expect(dispatchLocal).toHaveBeenCalledWith(SYN2('glide', 'sync'), true);
  });

  it('swaps to the step-division knob when glide.sync is on (readout shows the div label)', () => {
    const params = structuredClone(Synth2Engine.DEFAULT_PARAMS) as any;
    params.glide.sync = true;
    const el = mountPanel(params);
    const readout = el.querySelector('.glide-panel .knob-value')?.textContent?.trim();
    expect(readout).toBe('1 st'); // default div '1' rendered via ENV_SYNC_KNOB_LABELS
  });
});
