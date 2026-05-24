// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { saveProjectToFile, ProjectFileError } from './file-io';
import { freshProject } from './factory';

function makeFakeWritable() {
  return {
    write: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('ProjectFileError', () => {
  it('preserves the cause', () => {
    const cause = new Error('underlying');
    const e = new ProjectFileError('top', cause);
    expect(e.message).toBe('top');
    expect(e.cause).toBe(cause);
    expect(e.name).toBe('ProjectFileError');
  });
});

describe('saveProjectToFile — native (showSaveFilePicker)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('uses the native picker and writes serialized JSON', async () => {
    const writable = makeFakeWritable();
    const handle = { createWritable: vi.fn().mockResolvedValue(writable) };
    const picker = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showSaveFilePicker', picker);

    const p = freshProject();
    p.bpm = 140;
    await saveProjectToFile(p, 'my-song.json');

    expect(picker).toHaveBeenCalledTimes(1);
    expect(picker.mock.calls[0][0].suggestedName).toBe('my-song.json');
    expect(picker.mock.calls[0][0].types[0].accept).toEqual({
      'application/json': ['.json'],
    });
    expect(writable.write).toHaveBeenCalledTimes(1);
    const written = writable.write.mock.calls[0][0];
    expect(JSON.parse(written).bpm).toBe(140);
    expect(writable.close).toHaveBeenCalledTimes(1);
  });

  it('defaults suggestedName to "fiddle-project.json"', async () => {
    const writable = makeFakeWritable();
    const picker = vi.fn().mockResolvedValue({
      createWritable: vi.fn().mockResolvedValue(writable),
    });
    vi.stubGlobal('showSaveFilePicker', picker);

    await saveProjectToFile(freshProject());
    expect(picker.mock.calls[0][0].suggestedName).toBe('fiddle-project.json');
  });

  it('swallows AbortError (user cancellation)', async () => {
    const abort = new DOMException('User aborted', 'AbortError');
    const picker = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(saveProjectToFile(freshProject())).resolves.toBeUndefined();
  });

  it('wraps other errors in ProjectFileError', async () => {
    const picker = vi.fn().mockRejectedValue(new Error('quota exceeded'));
    vi.stubGlobal('showSaveFilePicker', picker);

    await expect(saveProjectToFile(freshProject()))
      .rejects.toBeInstanceOf(ProjectFileError);
  });
});

describe('saveProjectToFile — fallback (download anchor)', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    // No showSaveFilePicker → fallback path
  });

  it('creates and clicks a download anchor with serialized JSON', async () => {
    const fakeAnchor = {
      href: '',
      download: '',
      click: vi.fn(),
      remove: vi.fn(),
    };
    const createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'a') return fakeAnchor as unknown as HTMLAnchorElement;
      // Fall through for anything else (jsdom default)
      return document.createElement.call(document, tag) as HTMLElement;
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);
    const urlCreate = vi.fn().mockReturnValue('blob:fake-url');
    const urlRevoke = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: urlCreate, revokeObjectURL: urlRevoke });

    const p = freshProject();
    p.bpm = 90;
    await saveProjectToFile(p, 'fallback.json');

    expect(urlCreate).toHaveBeenCalledTimes(1);
    const blob = urlCreate.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('application/json');
    const text = await blob.text();
    expect(JSON.parse(text).bpm).toBe(90);

    expect(fakeAnchor.href).toBe('blob:fake-url');
    expect(fakeAnchor.download).toBe('fallback.json');
    expect(fakeAnchor.click).toHaveBeenCalledTimes(1);
    expect(fakeAnchor.remove).toHaveBeenCalledTimes(1);
    expect(urlRevoke).toHaveBeenCalledWith('blob:fake-url');

    createElementSpy.mockRestore();
    appendSpy.mockRestore();
  });
});
