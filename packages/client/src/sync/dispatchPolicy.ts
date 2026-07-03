// Leaf fields edited as a single discrete action (a select or toggle) flush to
// the wire immediately; everything else (knobs/sliders/drags) rides the 50ms
// throttle. Centralized here so the policy lives in one place rather than being
// re-derived inline in each watcher. Keyed by leaf field name — unambiguous
// across the accept-list (no continuous and discrete field share a name).
export const DISCRETE_LEAF_FIELDS = new Set<string>([
  'engineType', 'muted', 'soloed', 'note', 'octave', 'isChord', 'chordType', 'patternLength', 'enabled',
  'sync', // synth2 osc hard-sync toggle: an instantaneous discrete flip, like muted/soloed
  'loop', // synth2 envelope loop toggle (I3c): a discrete flip — flush immediately
  'type', // synth2 filter.type enum: a discrete selector flip — flush immediately
  'source', // synth2 matrix route source enum — discrete selector flip
  'dest',   // synth2 matrix route dest enum — discrete selector flip
  'model',  // synth2 filter.model enum (I3d): a discrete selector flip — flush immediately
  // ('amount' is intentionally NOT here — a continuous knob that rides the throttle.)
]);
export function gestureEndForLeaf(leafKey: string): boolean {
  return DISCRETE_LEAF_FIELDS.has(leafKey);
}
