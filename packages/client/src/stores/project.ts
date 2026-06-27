import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import { freshProject, replaceProject, type Project, type ProjectTrack } from '../project';

// THE single canonical project instance for the whole app. Lifted to module
// scope (Phase 1) so the Pinia store and the legacy `useSynth` module share ONE
// object: useSynth imports this instead of creating its own. This matches
// useSynth's existing module-scope singleton (useSynth.ts:66 before Phase 1).
// Phase 5 moves creation into AppRuntime.bootstrap (one instance per page) and
// drops this module-scope singleton.
//
// Holds ONLY data — no socket, no AudioContext, no timers.
const project = reactive<Project>(freshProject());

export const useProjectStore = defineStore('project', () => {
  const enabledTrackCount = computed(() => project.tracks.filter((t) => t.enabled).length);

  function getTrack(index: number): ProjectTrack {
    return project.tracks[index];
  }

  // Replace the project's contents in place (snapshot load / future reconnect),
  // preserving the `project` object identity so reactive bindings survive.
  function loadProject(next: Project): void {
    replaceProject(project, next);
  }

  return { project, enabledTrackCount, getTrack, loadProject };
});

// Raw access to the canonical instance for the legacy useSynth module (and the
// sync layer it feeds), which still mutates project directly this phase.
// Removed in Phase 2 when all writes funnel through the command bus.
export { project };

// Test-only: reset the shared module-scope instance between cases. The module
// singleton means setActivePinia(createPinia()) alone no longer isolates project
// state. Removed in Phase 5 when creation moves to AppRuntime.bootstrap.
export function __resetProjectStoreForTest(): void {
  replaceProject(project, freshProject());
}
