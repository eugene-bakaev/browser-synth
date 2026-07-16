# Synth2 Portamento (Glide) — Design

Date: 2026-07-16
Status: validated in brainstorm, pending user spec review
Branch: feat/synth2-portamento (off main 7846ef0)

## 1. Goal

Add a portamento (glide) control to the synth2 engine: in mono mode, each new
note slides from the previously played pitch to its own pitch over a
configurable time, optionally tempo-synced to sequencer steps. The classic
TB-303 / mono-synth slide.

This is also the first audible-behavior change verified end-to-end with the
audio lab (`pitchSettleTime` was built for exactly this).

## 2. Decisions (validated with the user)

| Decision | Choice | Rationale |
|---|---|---|
| Scope | **Mono mode only** | Mono retriggers voice 0, so "previous pitch" is unambiguous. In poly the knob is inert (visible, synced, no effect). |
| Glide law | **Constant time, log-pitch domain** | Every glide takes the knob's time regardless of interval size; pitch moves linearly in octaves (constant cents/sec within a glide). Predictable against the step grid. |
| Trigger rule | **Always glide** | Every mono note glides from the last played pitch, even across silence — the voice remembers its pitch between gates (303-sequencer feel). First note after engine construction snaps (no glide). |
| Modulatable | **Yes** | `glide.time` joins MOD_DESTS like env times (expOctaves taper, modScale 4). Velocity→glide and LFO→glide work through the existing matrix. |
| Tempo sync | **Yes, env-style** | `glide.sync` + `glide.div` reuse the envelope step-fraction vocabulary (ENV_SYNC_LABELS). Derived seconds computed on the main thread; kernel stays tempo-agnostic. |
| Off state | **min = default = 0.001 s** | Same "effectively instant" convention as env attack. A 1 ms glide is audibly identical to today's snap; no special off-branch in the kernel. |

## 3. Param & wire

Three rows appended to `SYNTH2_DESCRIPTORS` (append-only table; block indices
are array positions):

```ts
// --- Portamento (2026-07-16, append-only). glide.time is the mono-mode
// pitch-glide duration (constant-time, log-pitch domain). Modulatable like
// env times. glide.sync/glide.div are MAIN-THREAD-ONLY dead block slots
// exactly like env*.sync/env*.aDiv: when sync is on, AudioEngine derives
// seconds from the step division × bpm and writes them into glide.time
// before the block reaches the kernel — the kernel never reads these rows.
{ key: 'glide.time', min: 0.001, max: 2, default: 0.001, taper: 'expOctaves', modulatable: true,  modScale: 4, curve: 'exp', label: 'Glide' },
{ key: 'glide.sync', min: 0, max: 1, default: 0, taper: 'linear', modulatable: false, modScale: 0, kind: 'bool', label: 'Sync' },
{ key: 'glide.div',  min: 0, max: ENV_SYNC_LABELS.length - 1, default: ENV_SYNC_DEFAULT_INDEX, taper: 'linear', modulatable: false, modScale: 0, kind: 'enum', enumValues: ENV_SYNC_LABELS, label: 'Glide Div' },
```

- Wire paths: `engines.synth2.glide.time` / `.sync` / `.div`. Schema leaves,
  accept-list patterns, `DEFAULT_SYNTH2_PARAMS`, the kernel block layout
  (`PARAM_INDEX`, `PARAM_COUNT`, and therefore `MATRIX_BASE`), and `MOD_DESTS`
  all auto-derive from the table; existing contract tests assert the
  derivations.
- `Synth2EngineParams` gains:

```ts
export interface Synth2GlideParams {
  time: number;  // seconds — free-mode glide; when sync is on the kernel receives
                 // a main-thread-derived duration instead (this leaf is never overwritten)
  sync: boolean; // tempo-sync on/off (time derived from div × bpm on the main thread)
  div: string;   // step-division label from ENV_SYNC_DIVISIONS (used when sync is on)
}
```

  added to `Synth2EngineParams` as `glide: Synth2GlideParams` (interface ↔
  table agreement is already covered by the synth2.test.ts contract test).
- Default div `'1'` (= `ENV_SYNC_DEFAULT_LABEL`): the glide spans exactly one
  sequencer step — the 303 slide (125 ms @ 120 BPM) — and scales with BPM.
- Both sides of the wire rebuild the param block from the same descriptor
  table, so appending rows (which shifts `MATRIX_BASE`) is not an ABI concern;
  the block never crosses a version boundary.

## 4. Kernel behavior (Voice + Synth2Kernel)

All glide state lives in `Voice`; `Synth2Kernel` only forwards the event's
existing `mono` flag into `Voice.noteOn`.

- `Voice` gains persistent pitch memory: `lastFreq` (the previous note's
  target frequency, surviving across notes, gates, and silence) and a
  `hasPlayed` flag (false only before the first-ever note on that voice).
- `noteOn(freq, velocity, gateFrames, mono)`:
  - Poly note, or first-ever note, or `mono === false`: snap — current pitch
    = target pitch, exactly today's behavior.
  - Mono note with `hasPlayed`: latch `glideIntervalOct =
    log2(targetFreq / lastFreq)` and set the glide position to the previous
    pitch. `keyTrackOctaves` stays latched to the **target** pitch at noteOn
    (as today): the filter keytrack does not re-sweep during the glide.
- Per sample in `renderAdd`: the rendered frequency is
  `targetFreq · 2^(remainingOct)` where `remainingOct` moves toward 0 by
  `|glideIntervalOct| / (glideTime · sampleRate)` each sample, clamping at 0.
  `glideTime` is `glideSlot.next()` — the smoothed, matrix-modulated per-sample
  value (floored at 0.001 s defensively), so mod applies mid-glide; the
  constant-time law holds exactly when the slot value is stable, and degrades
  gracefully (rate re-derived per sample from the latched interval) when
  modulated.
  - Voice 0 in mono mode is the only voice that ever has a nonzero
    `remainingOct`, so poly voices pay one comparison (`remainingOct === 0`)
    and take the existing path.
  - The per-sample freq feeds the existing `osc1/2/3.next(freq)` calls
    unchanged; TZFM and hard sync chains see the gliding master frequency
    coherently (all three oscillators share the same glide).
- The Nyquist cap stays enforced: both endpoints are already capped at noteOn,
  and a glide between two capped endpoints cannot exceed the higher one.
- `glide.sync` / `glide.div` are never read by the kernel (dead slots).

## 5. Main-thread derivation (AudioEngine)

Mirrors `effectiveEnvTimes` / `effectiveLfoRate`:

```ts
function effectiveGlideTime(
  glide: { sync?: boolean; div?: string; time: number },
  bpm: number,
): number {
  if (!glide.sync) return glide.time;
  return Math.min(2, Math.max(0.001, envDivisionToSeconds(glide.div ?? ENV_SYNC_DEFAULT_LABEL, bpm)));
}
```

- Applied in `syncTrackToEngine`'s synth2 branch: spread
  `glide: { ...s2.glide, time: effectiveGlideTime(s2.glide, project.bpm) }`
  alongside the lfo/env spreads.
- `glide` joins the bpm-change re-push loop (the `p[0] === 'bpm'` handler)
  next to `env1/2/3`: a tempo change re-derives and re-pushes the seconds for
  any synced glide.
- Clamp ceiling is 2 (the descriptor max), not the envelopes' 10: at 40 BPM a
  32-step division derives 12 s — the clamp is load-bearing at the slow
  extreme, same shape as the env clamp comment.

## 6. UI (Synth2Panel)

- One glide control next to the MONO/POLY toggle in `.synth-mode-selector`
  (it is a play-mode-level control, not an osc-module one):
  - `glide.sync` off: `Knob` with `format="ms"`, `curve="exp"`, min 0.001,
    max 2, step 0.001 — the free-time knob.
  - `glide.sync` on: the same `v-if`/`v-else` swap the env A/D/R knobs use —
    stepped knob over `ENV_SYNC_KNOB_LABELS` writing `ENV_SYNC_LABELS[$event]`
    to `glide.div`.
  - A SYNC toggle button styled like the env sections' `env-sync-btn`.
- Labels come from `knobLabel('glide.time')` etc. (synth2-labels.ts needs no
  change — it renders from the descriptor `label` fields).
- The knob stays visible and editable in poly mode (synced, inert) — no
  conditional hiding; matches "mono only" semantics with zero mode-switch
  surprise.

## 7. Verification

- **Unit (kernel):** Voice/Kernel tests — mono glide reaches the target in
  T ± tolerance and holds; pitch is monotonic during the glide; first-ever
  note snaps; poly notes snap; `mono=false` events never glide; glide time
  floor behaves (0.001 s ≈ instant); param-block contract tests pick up the
  three new rows automatically.
- **Unit (main thread):** `effectiveGlideTime` free/synced/clamped cases;
  bpm-change re-push includes glide (mirrors the existing env sync tests).
- **Audio lab (the point of this exercise):**
  `npm run lab -- render-engine synth2 --mono --notes "A2:0:0.4,A3:0.5:0.4"`
  baseline (default glide 0.001) vs `--set glide.time=0.3`:
  - baseline: `pitchSettleTime` after the second onset ≈ 0 (snap);
  - glide run: `pitchSettleTime` ≈ 0.3 s ± tolerance, f0 track shows a smooth
    A2→A3 ramp, `medianF0` of the tail segment = A3 ± 1 Hz;
  - `compare` the two run dirs; read the pitch SVG/spectrogram.
  - Tolerances only (renders are not bit-identical — kernel PRNGs free-run).
- **Browser (mandatory):** dev app via the user's `npm run dev:obs` stack,
  synth2 track, place two steps at different pitches, turn GLIDE up, hear the
  slide; toggle SYNC and change BPM; verify poly mode unaffected; clean
  console; close all tabs/sessions. Worklet is prebuilt — rebuild + full page
  reload before judging DSP changes.

## 8. Non-goals / known limitations

- No glide in poly mode (decided; the knob is inert there).
- No legato-only mode (decided: always glide; could be a later bool).
- **Old-session param-append gap (pre-existing, NOT fixed here):** sessions
  saved before this change lack `engines.synth2.glide` entirely, so glide
  edits in those sessions won't sync (server normalize heals slice-level, not
  param-level; `setDeep` drops the op on the missing parent). Recurs on every
  descriptor append; the deep-merge fix in shared normalize.ts is a separate
  backlog item. New sessions are unaffected.
- Phase-2 audio-lab items (whole-project render) are unrelated and unchanged.
