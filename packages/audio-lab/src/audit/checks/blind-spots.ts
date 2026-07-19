// Params NO Tier-1 check can exercise, with the reason. The completeness
// meta-test forces every descriptor key to appear either in a check or here —
// appending a param to any v2 engine breaks the gate until it's classified.
const SYNC_DERIVED =
  'main-thread derived (effectiveLfoRate/effectiveEnvTimes/effectiveGlideTime); dead kernel slot in Tier 1 — covered by shared unit tests now, sub-project C end-to-end later';

export const BLIND_SPOTS: Record<string, string> = {
  'lfo1.sync': SYNC_DERIVED, 'lfo1.div': SYNC_DERIVED,
  'lfo2.sync': SYNC_DERIVED, 'lfo2.div': SYNC_DERIVED,
  'env1.sync': SYNC_DERIVED, 'env1.aDiv': SYNC_DERIVED, 'env1.dDiv': SYNC_DERIVED, 'env1.rDiv': SYNC_DERIVED,
  'env2.sync': SYNC_DERIVED, 'env2.aDiv': SYNC_DERIVED, 'env2.dDiv': SYNC_DERIVED, 'env2.rDiv': SYNC_DERIVED,
  'env3.sync': SYNC_DERIVED, 'env3.aDiv': SYNC_DERIVED, 'env3.dDiv': SYNC_DERIVED, 'env3.rDiv': SYNC_DERIVED,
  'glide.sync': SYNC_DERIVED, 'glide.div': SYNC_DERIVED,
};
