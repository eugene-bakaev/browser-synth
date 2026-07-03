import { defineStore } from 'pinia';
import { reactive, computed } from 'vue';
import { freshProject, replaceProject, type Project, type ProjectTrack, type EngineType } from '../project';
import { setDeep, type Path } from '@fiddle/shared';

export const useProjectStore = defineStore('project', () => {
  // THE canonical project instance — created per Pinia instance, i.e. per
  // AppRuntime (one per page; one per test runtime). Phase 5: creation moved
  // in here from module scope, so re-evaluating any module mints nothing.
  // Holds ONLY data — no socket, no AudioContext, no timers.
  const project = reactive<Project>(freshProject());

  const enabledTrackCount = computed(() => project.tracks.filter((t) => t.enabled).length);

  function getTrack(index: number): ProjectTrack {
    return project.tracks[index];
  }

  const bpm = computed(() => project.bpm);

  function getTrackEngineType(index: number): EngineType {
    return project.tracks[index].engineType;
  }

  // The single low-level state-write primitive — reached ONLY via the
  // CommandBus. Pure state: no suppression, no opId logic, no sync.
  function applySet(path: Path, value: unknown): void {
    setDeep(project as unknown as Record<string, unknown>, path, value);
  }

  // Replace the project's contents in place (snapshot load / Open / New / room
  // reset), preserving object identity so reactive bindings survive. Reached
  // ONLY via CommandBus.loadProject.
  function loadProject(next: Project): void {
    replaceProject(project, next);
  }

  return { project, enabledTrackCount, getTrack, getTrackEngineType, bpm, applySet, loadProject };
});
