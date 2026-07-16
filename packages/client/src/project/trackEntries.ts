import type { Project, ProjectTrack } from './types';

export interface TrackEntry {
  track: ProjectTrack;
  /** Pool index — track IDENTITY (colors, sync paths, focus, selection). */
  index: number;
  /** 0-based position among ENABLED tracks in display order — used ONLY for
   *  presentation (the `Track ${n+1}` fallback numbering). */
  displayPos: number;
}

// Enabled slots in display order. The single definition of "the track list
// the user sees" — StudioView's overview grid and TrackMixer both consume it.
export function orderedEnabledEntries(
  project: Pick<Project, 'tracks' | 'trackOrder'>,
): TrackEntry[] {
  const entries: TrackEntry[] = [];
  for (const index of project.trackOrder) {
    const track = project.tracks[index];
    if (track?.enabled) entries.push({ track, index, displayPos: entries.length });
  }
  return entries;
}
