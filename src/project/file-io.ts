import type { Project } from './types';
import { serializeProject, deserializeProject } from './storage';

export class ProjectFileError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

// Save the project to disk. On Chrome/Edge uses the native File System
// Access API. On Safari/Firefox falls back to a programmatic download
// anchor. User cancellation of the native picker is silent (no error).
export async function saveProjectToFile(
  project: Project,
  suggestedName: string = 'fiddle-project.prj.json',
): Promise<void> {
  const json = serializeProject(project);

  const picker = (globalThis as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: 'Fiddle project',
          accept: { 'application/json': ['.json', '.prj.json'] },
        }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e) {
      if (isAbortError(e)) return;
      throw new ProjectFileError(
        `Failed to save project: ${e instanceof Error ? e.message : 'unknown error'}`,
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

// Open a project from disk. On Chrome/Edge uses the native File System
// Access API. On Safari/Firefox falls back to a hidden <input type="file">.
// Returns null if the user cancels. Throws ProjectFileError for unreadable
// or future-schemaVersion files.
export async function openProjectFromFile(): Promise<Project | null> {
  const picker = (globalThis as any).showOpenFilePicker;
  if (typeof picker === 'function') {
    let handles: any[];
    try {
      handles = await picker({
        types: [{
          description: 'Fiddle project',
          accept: { 'application/json': ['.json', '.prj.json'] },
        }],
        multiple: false,
      });
    } catch (e) {
      if (isAbortError(e)) return null;
      throw new ProjectFileError(
        `Failed to open project: ${e instanceof Error ? e.message : 'unknown error'}`,
        e,
      );
    }
    const file = await handles[0].getFile();
    const text = await file.text();
    return parseOrWrap(text);
  }

  const file = await pickFileViaInput();
  if (file === null) return null;
  const text = await file.text();
  return parseOrWrap(text);
}

function parseOrWrap(text: string): Project {
  try {
    return deserializeProject(text);
  } catch (e) {
    throw new ProjectFileError(
      `Could not load project: ${e instanceof Error ? e.message : 'unknown error'}`,
      e,
    );
  }
}

function pickFileViaInput(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json,.prj.json';
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
