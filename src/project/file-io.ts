import type { Project } from './types';
import { serializeProject } from './storage';

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
  suggestedName: string = 'fiddle-project.json',
): Promise<void> {
  const json = serializeProject(project);

  const picker = (globalThis as any).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker({
        suggestedName,
        types: [{
          description: 'Fiddle project',
          accept: { 'application/json': ['.json'] },
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
