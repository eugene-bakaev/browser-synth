import type { PresetRecord } from '@fiddle/shared';

export function groupPresets(
  all: PresetRecord[],
  currentUserId: string | null,
): { yours: PresetRecord[]; others: PresetRecord[] } {
  const yours: PresetRecord[] = [];
  const others: PresetRecord[] = [];
  for (const p of all) {
    if (currentUserId !== null && p.ownerUserId === currentUserId) yours.push(p);
    else others.push(p);
  }
  return { yours, others };
}
