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
