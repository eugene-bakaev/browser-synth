import type { Preset } from './preset';
import { serializePreset, deserializePreset } from './preset';

export class PresetFileError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'PresetFileError';
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

// Save a preset to disk. Native File System Access API on Chrome/Edge;
// download-anchor fallback on Safari/Firefox. User cancellation is silent.
export async function savePresetToFile(
  preset: Preset,
  suggestedName: string = `${preset.engineType}-preset.chnl.json`,
): Promise<void> {
  const json = serializePreset(preset);

  const picker = (globalThis as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: 'Fiddle preset',
          accept: { 'application/json': ['.chnl.json'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e) {
      if (isAbortError(e)) return;
      throw new PresetFileError(
        `Failed to save preset: ${e instanceof Error ? e.message : 'unknown error'}`,
        e,
      );
    }
  }

  // Fallback — programmatic download
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Open a preset from disk. Native picker where available, hidden <input>
// fallback otherwise. Returns null if the user cancels. Throws
// PresetFileError for unreadable / corrupt files.
export async function openPresetFromFile(): Promise<Preset | null> {
  const picker = (globalThis as any).showOpenFilePicker;
  if (typeof picker === 'function') {
    let handles: any[];
    try {
      handles = await picker({
        types: [{
          description: 'Fiddle preset',
          accept: { 'application/json': ['.chnl.json'] },
        }],
        multiple: false,
      });
    } catch (e) {
      if (isAbortError(e)) return null;
      throw new PresetFileError(
        `Failed to open preset: ${e instanceof Error ? e.message : 'unknown error'}`,
        e,
      );
    }
    const file = await handles[0].getFile();
    const text = await file.text();
    return parseOrWrap(text);
  }

  const file = await pickFileViaInput();
  if (file === null) return null;
  const text = await (file as any).text();
  return parseOrWrap(text);
}

function parseOrWrap(text: string): Preset {
  try {
    return deserializePreset(text);
  } catch (e) {
    throw new PresetFileError(
      `Could not load preset: ${e instanceof Error ? e.message : 'unknown error'}`,
      e,
    );
  }
}

function pickFileViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.chnl.json';
    input.style.display = 'none';

    const cleanup = () => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      input.remove();
    };
    const onChange = () => {
      const file = input.files && input.files.length > 0 ? input.files[0] : null;
      cleanup();
      resolve(file);
    };
    const onCancel = () => {
      cleanup();
      resolve(null);
    };

    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    document.body.appendChild(input);
    input.click();
  });
}
