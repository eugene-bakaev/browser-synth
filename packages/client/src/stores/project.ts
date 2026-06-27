import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import { freshProject, replaceProject, type Project, type ProjectTrack } from '../project';

// Canonical project state. Holds ONLY data — no socket, no AudioContext, no
// timers (those are resources owned by the composition root, not state).
// Phase 0: nothing consumes this yet; it exists so later phases can migrate
// reads here, then route all writes through a single command applier.
export const useProjectStore = defineStore('project', () => {
  // reactive() (not ref()) so nested mutation keeps working exactly as the
  // legacy module-scope `project` did; `.project` keeps a stable identity so
  // loadProject can replace contents in place without breaking references.
  const project = reactive<Project>(freshProject());

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
