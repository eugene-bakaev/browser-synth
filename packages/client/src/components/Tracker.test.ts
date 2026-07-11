// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import { createPinia } from 'pinia';
import Tracker from './Tracker.vue';
import { freshStep } from '../project';
import { DEFAULT_MIXER_STATE } from '../project';
import { SYNTH_CONTEXT, type SynthContext } from '../app/synthContext';
import { useSelectionStore } from '../stores/selection';
import { useProjectStore } from '../stores/project';

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
  // Tracker's setup() now calls useSelectionStore() unconditionally (row
  // selection), so every mount needs an active Pinia even when a test never
  // touches selection itself.
  app.use(createPinia());
  app.provide(SYNTH_CONTEXT, fakeSynth);
  app.mount(host);
  return host;
}

function makeSteps(n = 4) {
  return Array.from({ length: n }, () => freshStep());
}

// Selection-UI harness: installs a fresh Pinia so Tracker's internal
// useSelectionStore() call resolves, and heals the project store's track at
// the tested trackId so validSelection() (which validates against live
// project state) accepts placements — enabled + patternLength >= 16, to
// cover the shift+click-to-row-6 and patternLength>16 auto-scroll tests.
function mountTrackerWithPinia(overrideProps: Record<string, unknown> = {}): {
  el: HTMLElement;
  selection: ReturnType<typeof useSelectionStore>;
} {
  host = document.createElement('div');
  document.body.appendChild(host);
  const pinia = createPinia();
  const props = {
    ...BASE_PROPS,
    steps: makeSteps(16),
    engineType: 'kick',
    patternLength: 16,
    ...overrideProps,
  };
  app = createApp(Tracker, props);
  app.use(pinia);
  app.provide(SYNTH_CONTEXT, fakeSynth);
  const projectStore = useProjectStore(pinia);
  const tid = props.trackId as number;
  projectStore.project.tracks[tid].enabled = true;
  projectStore.project.tracks[tid].patternLength = props.patternLength as number;
  app.mount(host);
  return { el: host, selection: useSelectionStore(pinia) };
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

describe('title-is-custom shielding', () => {
  it('titleIsCustom: true puts the custom-name class on .track-name', () => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'kick',
      titleIsCustom: true,
    });
    expect(el.querySelector('.track-name.custom-name')).not.toBeNull();
  });

  it('titleIsCustom omitted (default false) leaves .track-name without custom-name', () => {
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'kick',
    });
    const name = el.querySelector('.track-name');
    expect(name).not.toBeNull();
    expect(name!.classList.contains('custom-name')).toBe(false);
  });
});

describe('title rename affordance (focused view)', () => {
  it('focused: title click emits rename, not select-track', () => {
    const onRename = vi.fn();
    const onSelectTrack = vi.fn();
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'kick',
      isFocused: true,
      onRename,
      onSelectTrack,
    });
    const name = el.querySelector('.track-name')!;
    expect(name.classList.contains('renameable')).toBe(true);
    name.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onSelectTrack).not.toHaveBeenCalled();
  });

  it('overview: title click still bubbles to select-track and never renames', () => {
    const onRename = vi.fn();
    const onSelectTrack = vi.fn();
    const el = mountTracker({
      ...BASE_PROPS,
      steps: makeSteps(),
      engineType: 'kick',
      isFocused: false,
      onRename,
      onSelectTrack,
    });
    const name = el.querySelector('.track-name')!;
    expect(name.classList.contains('renameable')).toBe(false);
    name.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(onSelectTrack).toHaveBeenCalledTimes(1);
    expect(onRename).not.toHaveBeenCalled();
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

describe('step selection UI', () => {
  // jsdom has no PointerEvent; a MouseEvent with the pointer type name and a
  // defined pointerId is what the component's handlers actually read.
  function ptr(type: string, init: MouseEventInit & { pointerId?: number } = {}): MouseEvent {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, 'pointerId', { value: init.pointerId ?? 1 });
    return e;
  }

  // jsdom has no layout: pin the container rect and each row's offsetHeight/
  // offsetTop so the geometry row lookup (clientY → row) has real numbers to
  // work with. The real .tracker-steps is a flex column with a 2px gap, so
  // the true row pitch is rowHeight + gap (22px here), not offsetHeight
  // alone — offsetTop mirrors that gapped layout. rect spans rows 0..15
  // (16 rows × 22px pitch = 352), top at y=0.
  function mockStepsGeometry(el: HTMLElement, rowHeight = 20, gap = 2, visibleRows = 16): HTMLElement {
    const steps = el.querySelector('.tracker-steps') as HTMLElement;
    const pitch = rowHeight + gap;
    vi.spyOn(steps, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: pitch * visibleRows, left: 0, right: 100,
      width: 100, height: pitch * visibleRows, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    for (let i = 0; i < steps.children.length; i++) {
      Object.defineProperty(steps.children[i], 'offsetHeight', { value: rowHeight, configurable: true });
      Object.defineProperty(steps.children[i], 'offsetTop', { value: i * pitch, configurable: true });
    }
    return steps;
  }

  it('pointerdown on a step-number cell places the selection; shift+pointerdown extends it', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 2 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[3].dispatchEvent(ptr('pointerdown'));
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 2, first: 3, last: 3, head: 3 });
    cells[6].dispatchEvent(ptr('pointerdown', { shiftKey: true }));
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 2, first: 3, last: 6, head: 6 });
  });

  it('non-primary-button pointerdown does not touch the selection', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    el.querySelectorAll('.step-row .col-step')[3].dispatchEvent(ptr('pointerdown', { button: 2 }));
    await nextTick();
    expect(selection.validSelection).toBeNull();
  });

  it('dragging from row 2 down over row 6 extends the selection to 2–6', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown'));
    steps.dispatchEvent(ptr('pointermove', { clientY: 6 * 22 + 10 })); // middle of row 6
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 2, last: 6, head: 6 });
  });

  // Catches the offsetHeight-only pitch bug: with a 2px flex gap, the true
  // row pitch is 22px (20 + 2), not 20px. Under the old (buggy) math
  // floor(274 / 20) = 13, one row past the pointer. The fix derives pitch
  // from sibling offsetTop delta, so floor(274 / 22) = 12 — exactly under
  // the pointer.
  it('drag lands on the exact row under the pointer even past row 8 (gap-aware pitch)', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown'));
    steps.dispatchEvent(ptr('pointermove', { clientY: 12 * 22 + 10 })); // middle of row 12
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 2, last: 12, head: 12 });
  });

  it('drag clamps to the edge rows when the pointer leaves the container vertically', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    el.querySelectorAll('.step-row .col-step')[4].dispatchEvent(ptr('pointerdown'));
    steps.dispatchEvent(ptr('pointermove', { clientY: 9999 })); // far below → bottom visible row
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 4, last: 15, head: 15 });
    steps.dispatchEvent(ptr('pointermove', { clientY: -50 })); // far above → top row
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 0, last: 4, head: 0 });
  });

  // Edge auto-scroll regression: at pattern length 16 the visible rect covers
  // the whole pattern, so clamping to the edge row IS the correct terminal
  // state (previous test). At length 32 only 16 rows are visible — a pointer
  // held past the container edge must walk the head one row *past* the
  // clamped visible edge on every move (the hidden neighbor), or the
  // cursorRow watcher's scrollRowIntoView never advances scrollTop and the
  // drag stalls dead at the edge row (observed live in the browser).
  it('pointer past the visible edge overshoots one row into the hidden pattern', async () => {
    const { el, selection } = mountTrackerWithPinia({
      trackId: 0,
      patternLength: 32,
      steps: makeSteps(32),
    });
    const steps = mockStepsGeometry(el); // 32 row children, rect still bottom=352 (16 visible)
    el.querySelectorAll('.step-row .col-step')[4].dispatchEvent(ptr('pointerdown'));

    // Past the bottom edge: clamped visible row is 15, overshoot lands on
    // hidden row 16.
    steps.dispatchEvent(ptr('pointermove', { clientY: 9999 }));
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 4, last: 16, head: 16 });

    // Simulate having scrolled 2 rows (44px) off the top, then push past the
    // top edge: clamped content row is floor(44/22)=2, overshoot lands on
    // hidden row 1.
    Object.defineProperty(steps, 'scrollTop', { value: 44, configurable: true });
    steps.dispatchEvent(ptr('pointermove', { clientY: -50 }));
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 1, last: 4, head: 1 });
  });

  it('pointermove with a different pointerId does not extend', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown', { pointerId: 1 }));
    steps.dispatchEvent(ptr('pointermove', { pointerId: 99, clientY: 6 * 22 + 10 }));
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 2, last: 2, head: 2 });
  });

  it('after pointerup, further pointermoves do not extend', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    el.querySelectorAll('.step-row .col-step')[2].dispatchEvent(ptr('pointerdown'));
    steps.dispatchEvent(ptr('pointerup'));
    steps.dispatchEvent(ptr('pointermove', { clientY: 6 * 22 + 10 }));
    await nextTick();
    expect(selection.validSelection).toMatchObject({ trackId: 0, first: 2, last: 2, head: 2 });
  });

  it('selected rows get .selected and the head row gets .sel-cursor', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    selection.place(0, 1);
    selection.extendTo(0, 2);
    await nextTick();
    const rows = el.querySelectorAll('.step-row');
    expect(rows[1].classList.contains('selected')).toBe(true);
    expect(rows[2].classList.contains('selected')).toBe(true);
    expect(rows[2].classList.contains('sel-cursor')).toBe(true);
    expect(rows[1].classList.contains('sel-cursor')).toBe(false);
    expect(rows[0].classList.contains('selected')).toBe(false);
  });

  it('rows on a different track render unselected', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    selection.place(1, 1);
    await nextTick();
    expect(el.querySelector('.step-row.selected')).toBeNull();
  });

  it('cmd+pointerdown toggles rows in and out of the selection', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[5].dispatchEvent(ptr('pointerdown', { metaKey: true }));
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 5]);
    cells[5].dispatchEvent(ptr('pointerdown', { metaKey: true })); // toggle off
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2]);
  });

  it('ctrl+pointerdown does the same (windows/linux)', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[5].dispatchEvent(ptr('pointerdown', { ctrlKey: true }));
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 5]);
  });

  it('cmd+drag extends the fresh active segment; earlier rows persist', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[8].dispatchEvent(ptr('pointerdown', { metaKey: true }));
    steps.dispatchEvent(ptr('pointermove', { clientY: 10 * 22 + 10 })); // row 10
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 8, 9, 10]);
    expect(selection.validSelection!.head).toBe(10);
  });

  it('cmd toggle-off does not start a drag', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const steps = mockStepsGeometry(el);
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[4].dispatchEvent(ptr('pointerdown', { shiftKey: true })); // 2..4
    cells[3].dispatchEvent(ptr('pointerdown', { metaKey: true })); // toggle 3 off
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 4]);
    steps.dispatchEvent(ptr('pointermove', { clientY: 8 * 22 + 10 })); // must not extend
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([2, 4]);
  });

  it('plain pointerdown collapses a gapped selection to the clicked row', async () => {
    const { el, selection } = mountTrackerWithPinia({ trackId: 0 });
    const cells = el.querySelectorAll('.step-row .col-step');
    cells[2].dispatchEvent(ptr('pointerdown'));
    cells[6].dispatchEvent(ptr('pointerdown', { metaKey: true }));
    cells[9].dispatchEvent(ptr('pointerdown'));
    await nextTick();
    expect(selection.validSelection!.rows).toEqual([9]);
  });
});
