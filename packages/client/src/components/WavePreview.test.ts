// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, reactive, h, nextTick, type App } from 'vue';
import WavePreview from './WavePreview.vue';
import * as preview from '../engine/synth2/preview/wavePreview';

// jsdom has no real 2D canvas, so painting no-ops. Mock the helper so we can
// assert reactivity without needing a canvas context; the helper's real
// behavior is covered by wavePreview.test.ts.
vi.mock('../engine/synth2/preview/wavePreview', () => ({
  renderOscShape: vi.fn(() => new Float32Array(4)),
  renderLfoShape: vi.fn(() => new Float32Array(4)),
}));

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mount(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(WavePreview, props);
  app.mount(host);
  return host;
}

describe('WavePreview', () => {
  it('renders a canvas for kind="osc" without throwing', () => {
    const el = mount({ kind: 'osc', morph: 1.4, pulseWidth: 0.5, color: '#fff' });
    expect(el.querySelector('.wave-preview canvas')).not.toBeNull();
  });

  it('renders a canvas for kind="lfo" without throwing', () => {
    const el = mount({ kind: 'lfo', shape: 2.5, color: '#fff' });
    expect(el.querySelector('.wave-preview canvas')).not.toBeNull();
  });

  it('does not throw on NaN params (hardening)', () => {
    const el = mount({ kind: 'osc', morph: NaN, pulseWidth: NaN, color: '#fff' });
    expect(el.querySelector('.wave-preview canvas')).not.toBeNull();
  });

  it('recomputes the buffer when a shape prop changes', async () => {
    const calls = vi.mocked(preview.renderOscShape);
    calls.mockClear();
    const state = reactive({ morph: 0 });
    host = document.createElement('div');
    document.body.appendChild(host);
    app = createApp({
      render: () => h(WavePreview, { kind: 'osc', morph: state.morph, pulseWidth: 0.5, color: '#fff' }),
    });
    app.mount(host);
    expect(calls.mock.calls.length).toBeGreaterThanOrEqual(1);
    const before = calls.mock.calls.length;
    state.morph = 2;
    await nextTick();
    expect(calls.mock.calls.length).toBeGreaterThan(before);
  });
});
