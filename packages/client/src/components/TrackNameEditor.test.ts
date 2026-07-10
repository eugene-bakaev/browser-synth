// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createApp, nextTick, type App } from 'vue';
import TrackNameEditor from './TrackNameEditor.vue';
import { TRACK_NAME_MAX_LENGTH } from '@fiddle/shared';

let app: App | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = null;
  host = null;
});

function mountEditor(props: Record<string, unknown>): HTMLElement {
  host = document.createElement('div');
  document.body.appendChild(host);
  app = createApp(TrackNameEditor, props);
  app.mount(host);
  return host;
}

function label(el: HTMLElement): HTMLElement | null {
  return el.querySelector('.track-name-label');
}
function input(el: HTMLElement): HTMLInputElement | null {
  return el.querySelector('.track-name-input');
}

async function beginEdit(el: HTMLElement): Promise<HTMLInputElement> {
  label(el)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextTick();
  const inp = input(el);
  expect(inp).not.toBeNull();
  return inp!;
}

async function type(inp: HTMLInputElement, value: string): Promise<void> {
  inp.value = value;
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('TrackNameEditor', () => {
  it('idle: renders displayName as a label, no input', () => {
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit: vi.fn() });
    expect(label(el)!.textContent).toContain('Track 1');
    expect(input(el)).toBeNull();
  });

  it('click begins editing, prefilled with the RAW name (empty when unnamed)', async () => {
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit: vi.fn() });
    const inp = await beginEdit(el);
    expect(inp.value).toBe('');
    expect(inp.maxLength).toBe(TRACK_NAME_MAX_LENGTH);
  });

  it('Enter commits the trimmed value and closes the editor', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Old', displayName: 'Old', onCommit });
    const inp = await beginEdit(el);
    await type(inp, '  Bassline  ');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Bassline');
    expect(input(el)).toBeNull();
  });

  it('blur commits', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit });
    const inp = await beginEdit(el);
    await type(inp, 'Lead');
    inp.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(onCommit).toHaveBeenCalledWith('Lead');
  });

  it('Escape cancels without emitting (and the follow-up blur stays silent)', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Keep me', displayName: 'Keep me', onCommit });
    const inp = await beginEdit(el);
    await type(inp, 'discarded');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    inp.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input(el)).toBeNull();
  });

  it('committing whitespace emits the empty string (revert to default)', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Old', displayName: 'Old', onCommit });
    const inp = await beginEdit(el);
    await type(inp, '   ');
    inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    expect(onCommit).toHaveBeenCalledWith('');
  });

  it('blur without editing (no-op rename) closes the editor without emitting', async () => {
    const onCommit = vi.fn();
    const el = mountEditor({ name: 'Lead', displayName: 'Lead', onCommit });
    const inp = await beginEdit(el);
    inp.dispatchEvent(new FocusEvent('blur'));
    await nextTick();
    expect(onCommit).not.toHaveBeenCalled();
    expect(input(el)).toBeNull();
  });

  it('idle shows a pencil button that also begins editing', async () => {
    const el = mountEditor({ name: '', displayName: 'Track 1', onCommit: vi.fn() });
    const pencil = el.querySelector<HTMLButtonElement>('.rename-btn');
    expect(pencil).not.toBeNull();
    pencil!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await nextTick();
    expect(input(el)).not.toBeNull();
    expect(el.querySelector('.rename-btn')).toBeNull(); // pencil hides while editing
  });
});
