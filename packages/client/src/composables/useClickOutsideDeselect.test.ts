// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, defineComponent, h, type App } from 'vue';
import { createPinia } from 'pinia';
import { useSelectionStore } from '../stores/selection';
import { useProjectStore } from '../stores/project';
import { useClickOutsideDeselect } from './useClickOutsideDeselect';

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
// store so validSelection accepts placements (it validates against live
// project state), and places a selection on track 0 rows 2..2.
function mountHarness(): { selection: ReturnType<typeof useSelectionStore> } {
  host = document.createElement('div');
  document.body.appendChild(host);
  const pinia = createPinia();
  const Comp = defineComponent({
    setup() {
      const selection = useSelectionStore();
      useClickOutsideDeselect(selection);
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

function down(target: EventTarget): void {
  target.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
}

describe('useClickOutsideDeselect', () => {
  it('clears the selection on a pointerdown outside every tracker card', () => {
    const { selection } = mountHarness();
    down(document.body);
    expect(selection.validSelection).toBeNull();
  });

  it('keeps the selection when the press lands inside a .tracker-container', () => {
    const { selection } = mountHarness();
    const card = document.createElement('div');
    card.className = 'tracker-container';
    const knob = document.createElement('button');
    card.appendChild(knob);
    document.body.appendChild(card);
    down(knob);
    expect(selection.validSelection).not.toBeNull();
  });

  it('keeps the selection when the press lands inside an aria-modal dialog', () => {
    const { selection } = mountHarness();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    const btn = document.createElement('button');
    dialog.appendChild(btn);
    document.body.appendChild(dialog);
    down(btn);
    expect(selection.validSelection).not.toBeNull();
  });

  it('does not call clear() when no valid selection exists', () => {
    const { selection } = mountHarness();
    selection.clear();
    const spy = vi.spyOn(selection, 'clear');
    down(document.body);
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes the listener on unmount', () => {
    const { selection } = mountHarness();
    app!.unmount();
    app = null; // afterEach must not double-unmount
    down(document.body);
    expect(selection.validSelection).not.toBeNull();
  });
});
