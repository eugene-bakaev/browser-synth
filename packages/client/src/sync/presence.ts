// presence — the reactive read-model for "who else is in the room and what are
// they touching right now". Plain Vue `ref`s, no Pinia: the dispatcher in
// useSynth.ts writes into it, components read from it.
//
// Two pieces of state:
//   - `roster` / `selfClientId`: the current room membership (set from the
//     server's presence.update fan-out) plus which entry is us, so we can skip
//     rendering our own activity.
//   - `touchedMap`: pathKey → who last touched it + their color + an expiry.
//     Each remote `set` op "lights up" its path for a short window so the UI can
//     draw a fading activity ring in the originator's color. Self-touches are
//     ignored (you already see your own edits).
//
// Touch records self-expire after TOUCH_TTL_MS via a per-write setTimeout; the
// `touchedFor` reader also treats an expired record as absent so a stale entry
// never renders even before its timer fires.

import { ref, type Ref } from 'vue';
import type { Identity, Path } from '@fiddle/shared';

export interface TouchedRecord {
  clientId: string;
  color: string;
  expiresAt: number;
}

export const roster: Ref<Identity[]> = ref([]);
export const selfClientId: Ref<string | null> = ref(null);

// Reactive map of pathKey → {clientId, color, expiresAt}. Set by remote
// ops. Components query touchedFor(path) for fade rendering.
const touchedMap = ref(new Map<string, TouchedRecord>());

const TOUCH_TTL_MS = 500;

export function noteRemoteTouch(path: Path, clientId: string): void {
  if (clientId === selfClientId.value) return;
  const r = roster.value.find(r => r.clientId === clientId);
  if (!r) return;
  const key = JSON.stringify(path);
  touchedMap.value.set(key, {
    clientId,
    color: r.color,
    expiresAt: Date.now() + TOUCH_TTL_MS,
  });
  // Schedule expiry — naive setTimeout per write; fine at our throttle.
  setTimeout(() => {
    const cur = touchedMap.value.get(key);
    if (cur && cur.expiresAt <= Date.now()) {
      touchedMap.value.delete(key);
      // Force reactivity by reassigning. (Map mutations don't always trigger.)
      touchedMap.value = new Map(touchedMap.value);
    }
  }, TOUCH_TTL_MS + 50);
}

export function touchedFor(path: Path): TouchedRecord | null {
  const rec = touchedMap.value.get(JSON.stringify(path));
  if (!rec || rec.expiresAt <= Date.now()) return null;
  return rec;
}

export function resetPresence(): void {
  roster.value = [];
  selfClientId.value = null;
  touchedMap.value = new Map();
}
