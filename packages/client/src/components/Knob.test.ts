// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, type App } from 'vue';
import Knob from './Knob.vue';

// Mounted without test-utils: createApp + a host element is enough to drive
// the pointer handlers, and emit listeners arrive as `onX` props.
function mountKnob(onUpdate: (v: number) => void) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const app = createApp(Knob, {
    label: 'CUT',
    min: 0,
    max: 100,
    step: 1,
    modelValue: 50,
    'onUpdate:modelValue': onUpdate,
  });
  app.mount(host);
  return { app, host };
}

function startDrag(host: HTMLElement, clientY: number) {
  const dial = host.querySelector('.knob-dial-container')!;
  dial.dispatchEvent(new MouseEvent('pointerdown', { clientY, bubbles: true }));
}

let mounted: { app: App; host: HTMLElement } | null = null;

afterEach(() => {
  mounted?.app.unmount();
  mounted?.host.remove();
  mounted = null;
  vi.restoreAllMocks();
});

describe('Knob drag listeners', () => {
  it('pointerup ends the drag: later moves stop emitting', () => {
    const updates: number[] = [];
    mounted = mountKnob((v) => updates.push(v));
    startDrag(mounted.host, 100);

    // Drag up 10px: dragRange 200, valueRange 100 → +5 from start (50).
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 90 }));
    expect(updates).toEqual([55]);

    window.dispatchEvent(new MouseEvent('pointerup'));
    window.dispatchEvent(new MouseEvent('pointermove', { clientY: 80 }));
    expect(updates).toEqual([55]); // listener removed on pointerup
  });

  it('unmounting mid-drag removes the window listeners (S2)', () => {
    // Track switch / panel swap mid-drag: the component unmounts while the
    // pointer is still down. Pre-fix the window listeners survived until the
    // next pointerup anywhere, running the drag handler (and its closure over
    // the dead component) on every mouse move. Vue swallows emits from an
    // unmounted instance, so the observable here is listener accounting, not
    // emission: every window listener added by the drag must be removed by
    // unmount, with the same function reference.
    const added = vi.spyOn(window, 'addEventListener');
    const removed = vi.spyOn(window, 'removeEventListener');

    const { app, host } = mountKnob(() => {});
    startDrag(host, 100);

    const dragListeners = added.mock.calls.filter(
      ([type]) => type === 'pointermove' || type === 'pointerup',
    );
    expect(dragListeners).toHaveLength(2); // the drag armed both

    app.unmount();
    host.remove();

    for (const [type, handler] of dragListeners) {
      expect(removed).toHaveBeenCalledWith(type, handler);
    }
  });
});

describe('Knob missing-value guard', () => {
  it('renders a blank value (no throw) when modelValue is undefined', () => {
    // An un-healed param leaf can reach a Knob as undefined before the snapshot
    // is repaired. The display must not call undefined.toString() and crash the
    // whole panel — it shows blank until a real value arrives.
    const host = document.createElement('div');
    document.body.appendChild(host);
    const app = createApp(Knob, {
      label: 'Morph', min: 0, max: 2, step: 0.01, modelValue: undefined,
    });
    expect(() => app.mount(host)).not.toThrow();
    expect((host.querySelector('.knob-value')?.textContent ?? '').trim()).toBe('');
    app.unmount();
    host.remove();
  });
});
