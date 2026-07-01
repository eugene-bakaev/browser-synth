// knobSync — bridges a focused-track panel's knobs to the sync layer.
//
// Two affordances need the *full* wire path of the param a knob edits:
//   - the remote-activity ring (Knob reads `touchedFor(syncPath)`), and
//   - gesture-end (mouseup flushes that path's pending outbox entry now).
//
// The path is `['tracks', activeTrackIndex, 'engines', <engine>, ...field]`.
// The engine + field are fixed per panel/knob, but `activeTrackIndex` lives on
// App.vue's `useSynth()` instance (each useSynth() call mints its own ref, so a
// panel can't just call useSynth() to read it). App provides it via inject;
// panels pull it through this composable.
//
// TrackMixer is the exception — it edits every track by loop index (not the
// focused one) and writes the `mixer` slice, so it builds paths inline and
// calls endGesture() directly rather than using this composable.

import { inject, ref, type InjectionKey, type Ref } from 'vue';
import type { EngineType, Path } from '@fiddle/shared';
import { dispatchLocal, endGesture } from '../composables/useSynth';

/** App.vue provides its `activeTrackIndex` ref under this key. */
export const ACTIVE_TRACK_KEY: InjectionKey<Ref<number | null>> = Symbol('activeTrackIndex');

export function useKnobSync(engine: EngineType) {
  // Default to a null ref so a panel rendered outside the provider (tests,
  // storybook) degrades to dormant affordances rather than throwing.
  const activeTrack = inject(ACTIVE_TRACK_KEY, ref<number | null>(null));

  function pathFor(field: string | ReadonlyArray<string | number>): Path {
    const idx = activeTrack.value;
    if (idx === null) return [];
    const tail = Array.isArray(field) ? field : [field];
    return ['tracks', idx, 'engines', engine, ...tail];
  }

  function end(field: string | ReadonlyArray<string | number>): void {
    endGesture(pathFor(field));
  }

  type Field = string | ReadonlyArray<string | number>;

  // The single write primitive for every focused-track panel control: knobs
  // (via `@update:modelValue`), selects (`@change`), and toggles (`@click`) all
  // route their writes here, which dispatches through the command bus. Reads
  // stay one-way off the panel's `params` prop (the live reactive engine slice),
  // so a control never mutates `project` directly. No-op with no active track.
  function set(field: Field, value: unknown): void {
    const p = pathFor(field);
    if (p.length === 0) return;
    dispatchLocal(p, value);
  }

  return { pathFor, end, set };
}
