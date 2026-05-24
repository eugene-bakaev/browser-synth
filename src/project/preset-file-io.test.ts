// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  savePresetToFile,
  openPresetFromFile,
  PresetFileError,
} from './preset-file-io';
import { makePreset } from './preset';
import { SynthEngine } from '../engine/SynthEngine';

describe('savePresetToFile — native picker path', () => {
  let writeMock: ReturnType<typeof vi.fn>;
  let closeMock: ReturnType<typeof vi.fn>;
  let pickerMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeMock = vi.fn().mockResolvedValue(undefined);
    closeMock = vi.fn().mockResolvedValue(undefined);
    const handle = {
      createWritable: vi.fn().mockResolvedValue({ write: writeMock, close: closeMock }),
    };
    pickerMock = vi.fn().mockResolvedValue(handle);
    vi.stubGlobal('showSaveFilePicker', pickerMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls showSaveFilePicker with .chnl.json filter and writes the serialized preset', async () => {
    const preset = makePreset('synth', SynthEngine.DEFAULT_PARAMS);
    await savePresetToFile(preset);
    expect(pickerMock).toHaveBeenCalledTimes(1);
    const call = pickerMock.mock.calls[0][0];
    expect(call.types[0].accept).toEqual({ 'application/json': ['.chnl.json'] });
    expect(call.suggestedName).toBe('synth-preset.chnl.json');
    expect(writeMock).toHaveBeenCalledTimes(1);
    const written = writeMock.mock.calls[0][0];
    expect(JSON.parse(written).engineType).toBe('synth');
    expect(closeMock).toHaveBeenCalledTimes(1);
  });

  it('silently no-ops on user-cancellation (AbortError)', async () => {
    pickerMock.mockRejectedValue(new DOMException('User cancelled', 'AbortError'));
    const preset = makePreset('kick', { ...SynthEngine.DEFAULT_PARAMS } as any);
    await expect(savePresetToFile(preset)).resolves.toBeUndefined();
    expect(writeMock).not.toHaveBeenCalled();
  });

  it('throws PresetFileError on a non-abort failure', async () => {
    pickerMock.mockRejectedValue(new Error('permission denied'));
    const preset = makePreset('synth', SynthEngine.DEFAULT_PARAMS);
    await expect(savePresetToFile(preset)).rejects.toBeInstanceOf(PresetFileError);
  });
});

describe('savePresetToFile — fallback download anchor', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let anchorClick: ReturnType<typeof vi.fn>;
  let anchorRemove: ReturnType<typeof vi.fn>;
  let createObjectURLSpy: ReturnType<typeof vi.spyOn>;
  let revokeObjectURLSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.stubGlobal('showSaveFilePicker', undefined);
    anchorClick = vi.fn();
    anchorRemove = vi.fn();
    const realCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'a') {
        el.click = anchorClick;
        el.remove = anchorRemove;
      }
      return el;
    });
    createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:fake');
    revokeObjectURLSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    createElementSpy.mockRestore();
    createObjectURLSpy.mockRestore();
    revokeObjectURLSpy.mockRestore();
  });

  it('creates a download anchor when native picker is unavailable', async () => {
    const preset = makePreset('snare', { tune: 200, decay: 0.3, snappy: 0.5 } as any);
    await savePresetToFile(preset);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(anchorRemove).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLSpy).toHaveBeenCalledWith('blob:fake');
  });
});

describe('openPresetFromFile — native picker path', () => {
  let pickerMock: ReturnType<typeof vi.fn>;
  let fileText: string;

  beforeEach(() => {
    fileText = JSON.stringify({
      schemaVersion: 1,
      engineType: 'kick',
      params: { tune: 42, decay: 0.2, click: 0.3 },
    });
    const file = { text: vi.fn().mockResolvedValue(fileText) };
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    pickerMock = vi.fn().mockResolvedValue([handle]);
    vi.stubGlobal('showOpenFilePicker', pickerMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns the parsed preset', async () => {
    const preset = await openPresetFromFile();
    expect(preset).not.toBeNull();
    expect(preset!.engineType).toBe('kick');
    expect((preset!.params as any).tune).toBe(42);
  });

  it('returns null on AbortError (user cancellation)', async () => {
    pickerMock.mockRejectedValue(new DOMException('cancel', 'AbortError'));
    expect(await openPresetFromFile()).toBeNull();
  });

  it('throws PresetFileError on a corrupted file', async () => {
    const file = { text: vi.fn().mockResolvedValue('not json') };
    const handle = { getFile: vi.fn().mockResolvedValue(file) };
    pickerMock.mockResolvedValue([handle]);
    await expect(openPresetFromFile()).rejects.toBeInstanceOf(PresetFileError);
  });
});

describe('openPresetFromFile — fallback input', () => {
  let createElementSpy: ReturnType<typeof vi.spyOn>;
  let inputClick: ReturnType<typeof vi.fn>;
  let inputListeners: Record<string, EventListener>;

  beforeEach(() => {
    vi.stubGlobal('showOpenFilePicker', undefined);
    inputClick = vi.fn();
    inputListeners = {};
    const realCreate = document.createElement.bind(document);
    createElementSpy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = realCreate(tag) as any;
      if (tag === 'input') {
        el.click = inputClick;
        el.addEventListener = (type: string, l: EventListener) => { inputListeners[type] = l; };
        el.removeEventListener = vi.fn();
      }
      return el;
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    createElementSpy.mockRestore();
  });

  it('resolves with the parsed preset on change event', async () => {
    const promise = openPresetFromFile();
    const fakeFile = new Blob([JSON.stringify({
      schemaVersion: 1,
      engineType: 'hat',
      params: { decay: 0.2, tone: 6000, metallic: 0.7 },
    })], { type: 'application/json' });
    Object.defineProperty(fakeFile, 'text', { value: () => Promise.resolve(JSON.stringify({
      schemaVersion: 1,
      engineType: 'hat',
      params: { decay: 0.2, tone: 6000, metallic: 0.7 },
    })) });
    expect(inputClick).toHaveBeenCalled();
    const input = createElementSpy.mock.results.at(-1)!.value as any;
    Object.defineProperty(input, 'files', { value: [fakeFile] });
    inputListeners['change']!(new Event('change'));
    const result = await promise;
    expect(result!.engineType).toBe('hat');
  });

  it('resolves null on cancel event', async () => {
    const promise = openPresetFromFile();
    inputListeners['cancel']!(new Event('cancel'));
    expect(await promise).toBeNull();
  });
});
