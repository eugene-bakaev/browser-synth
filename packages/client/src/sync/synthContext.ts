// Injection key carrying the single useSynth() instance from the App shell down
// to the StudioView route. useSynth() must be called exactly once (its
// currentStep/activeTrackIndex are per-call refs), so the shell owns the call
// and provides the result here; StudioView injects it instead of calling
// useSynth() itself.
import type { InjectionKey } from 'vue';
import type { useSynth } from '../composables/useSynth';

export type SynthContext = ReturnType<typeof useSynth>;

export const SYNTH_CONTEXT: InjectionKey<SynthContext> = Symbol('synthContext');
