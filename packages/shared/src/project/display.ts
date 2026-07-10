import type { ProjectTrack } from './types.js';

// Single source of the track-label fallback rule: a track with an empty (or
// whitespace-only) custom name displays the live default `Track ${index + 1}`
// (`index` is the 0-based pool index). Every label site in the client goes
// through this helper so the rule can never fork.
export function trackDisplayName(track: Pick<ProjectTrack, 'name'>, index: number): string {
  const trimmed = track.name.trim();
  return trimmed !== '' ? trimmed : `Track ${index + 1}`;
}
