// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createPinia } from 'pinia';
import { useSelectionStore } from '../stores/selection';
import { useProjectStore } from '../stores/project';
import { useDeselectOnInputFocus } from './useDeselectOnInputFocus';

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  document.body.innerHTML = '';
  app = null;
  host = null;
});

// Mounts a bare component that registers the composable, heals the project
// store so validSelection accepts placements, and places a selection on
// track 0 row 2.
function mountHarness(): { selection: ReturnType<typeof useSelectionStore> } {
  host = document.createElement('div');
  document.body.appendChild(host);
  const pinia = createPinia();
  const Comp = defineComponent({
    setup() {
      const selection = useSelectionStore();
      useDeselectOnInputFocus(selection);
      return () => h('div');
    },
  });
  app = createApp(Comp);
  app.use(pinia);
  app.mount(host);
  const projectStore = useProjectStore(pinia);
  projectStore.project.tracks[0].enabled = true;
  projectStore.project.tracks[0].patternLength = 16;
  const selection = useSelectionStore(pinia);
  selection.place(0, 2);
  expect(selection.validSelection).not.toBeNull();
  return { selection };
}

function focus(el: HTMLElement): void {
  document.body.appendChild(el);
  el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
}

describe('useDeselectOnInputFocus', () => {
  it('clears the selection when an input takes focus', () => {
    const { selection } = mountHarness();
    focus(document.createElement('input'));
    expect(selection.validSelection).toBeNull();
  });

  it('clears the selection when a select takes focus', () => {
    const { selection } = mountHarness();
    focus(document.createElement('select'));
    expect(selection.validSelection).toBeNull();
  });

  it('keeps the selection when focus lands on a non-editable element', () => {
    const { selection } = mountHarness();
    const step = document.createElement('div');
    step.className = 'col-step';
    focus(step);
    expect(selection.validSelection).not.toBeNull();
  });

  it('keeps the selection when the focused input is inside an aria-modal dialog', () => {
    const { selection } = mountHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const input = document.createElement('input');
    dialog.appendChild(input);
    document.body.appendChild(dialog);
    input.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(selection.validSelection).not.toBeNull();
  });

  it('does not call clear() when no valid selection exists', () => {
    const { selection } = mountHarness();
    selection.clear();
    const spy = vi.spyOn(selection, 'clear');
    focus(document.createElement('input'));
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const { selection } = mountHarness();
    app!.unmount();
    app = null; // afterEach must not double-unmount
    focus(document.createElement('input'));
    expect(selection.validSelection).not.toBeNull();
  });
});
