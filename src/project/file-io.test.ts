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
      'application/json': ['.json', '.prj.json'],
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
    expect(picker.mock.calls[0][0].suggestedName).toBe('fiddle-project.prj.json');
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

import { openProjectFromFile } from './file-io';
import { PROJECT_SCHEMA_VERSION } from './types';

function makeFakeFile(contents: string): File {
  return new File([contents], 'test.json', { type: 'application/json' });
}

describe('openProjectFromFile — native (showOpenFilePicker)', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns the parsed project from the picked file', async () => {
    const seed = JSON.stringify({
      schemaVersion: 1,
      bpm: 156,
      tracks: [{}, {}, {}, {}],
    });
    const handle = { getFile: vi.fn().mockResolvedValue(makeFakeFile(seed)) };
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', picker);

    const project = await openProjectFromFile();
    expect(project).not.toBeNull();
    expect(project!.bpm).toBe(156);
    expect(project!.schemaVersion).toBe(PROJECT_SCHEMA_VERSION);
    expect(picker.mock.calls[0][0].multiple).toBe(false);
  });

  it('returns null on user cancellation (AbortError)', async () => {
    const abort = new DOMException('User aborted', 'AbortError');
    const picker = vi.fn().mockRejectedValue(abort);
    vi.stubGlobal('showOpenFilePicker', picker);

    const project = await openProjectFromFile();
    expect(project).toBeNull();
  });

  it('throws ProjectFileError for future schemaVersion', async () => {
    const seed = JSON.stringify({ schemaVersion: 99, bpm: 100, tracks: [] });
    const handle = { getFile: vi.fn().mockResolvedValue(makeFakeFile(seed)) };
    const picker = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(openProjectFromFile()).rejects.toBeInstanceOf(ProjectFileError);
  });

  it('wraps other picker errors in ProjectFileError', async () => {
    const picker = vi.fn().mockRejectedValue(new Error('disk read failed'));
    vi.stubGlobal('showOpenFilePicker', picker);

    await expect(openProjectFromFile()).rejects.toBeInstanceOf(ProjectFileError);
  });
});

describe('openProjectFromFile — fallback (<input type="file">)', () => {
  beforeEach(() => { vi.unstubAllGlobals(); });

  it('returns the parsed project after change event with a file', async () => {
    const seed = JSON.stringify({ schemaVersion: 1, bpm: 95, tracks: [{}, {}, {}, {}] });
    const file = makeFakeFile(seed);
    const fakeInput = {
      type: '',
      accept: '',
      style: { display: '' },
      files: [file] as unknown as FileList,
      click: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    let onChange: (() => void) | null = null;
    fakeInput.addEventListener = vi.fn((evt: string, cb: () => void) => {
      if (evt === 'change') onChange = cb;
    });

    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'input') return fakeInput as unknown as HTMLInputElement;
      return document.createElement.call(document, tag) as HTMLElement;
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);

    const promise = openProjectFromFile();

    // Wait for the input.click() to be called before firing change
    await Promise.resolve();
    expect(fakeInput.click).toHaveBeenCalled();
    onChange!();

    const project = await promise;
    expect(project).not.toBeNull();
    expect(project!.bpm).toBe(95);

    createSpy.mockRestore();
    appendSpy.mockRestore();
  });

  it('returns null when cancel event fires', async () => {
    const fakeInput = {
      type: '',
      accept: '',
      style: { display: '' },
      files: null as unknown as FileList,
      click: vi.fn(),
      remove: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    let onCancel: (() => void) | null = null;
    fakeInput.addEventListener = vi.fn((evt: string, cb: () => void) => {
      if (evt === 'cancel') onCancel = cb;
    });

    const createSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      if (tag === 'input') return fakeInput as unknown as HTMLInputElement;
      return document.createElement.call(document, tag) as HTMLElement;
    });
    const appendSpy = vi.spyOn(document.body, 'appendChild').mockImplementation((n: any) => n);

    const promise = openProjectFromFile();
    await Promise.resolve();
    onCancel!();

    const project = await promise;
    expect(project).toBeNull();

    createSpy.mockRestore();
    appendSpy.mockRestore();
  });
});
