# synth2 label unification — design

**Date:** 2026-07-15
**Status:** approved (brainstorm with Eugene, 2026-07-15)
**Scope:** synth2 panel + mod matrix only. synth1 panels, MixerPanel, TrackMixer,
Tracker are explicitly out of scope.

## Problem

The mod matrix dropdowns render raw wire keys verbatim (`Synth2Panel.vue`
prints `MOD_SOURCES` / `MOD_DESTS` entries directly), while the knobs and
headers use hand-written friendly labels. The two vocabularies have drifted:

- `osc*.coarse` / `osc*.fine` in the matrix vs **Octave** / **Detune** knobs —
  the matrix words appear nowhere on the panel.
- `env1` / `env2` sources and `env1.*` / `env2.*` dests vs **AMP ENV** /
  **FILTER ENV** headers — the numeric identity is never shown, so a matrix
  user has to guess env1 = amp, env2 = filter. The three envelope headers also
  mix naming schemes (two functional, one numeric: ENV 3).
- `fm.osc2` / `fm.osc3` vs **FM 1→2** / **FM 2→3** knobs.
- Cosmetic: `pulseWidth` vs PW, `filter.resonance` vs Res, `filter.keyTrack`
  vs KeyTrk, lowercase `lfo1` / `velocity` sources vs LFO 1 headers.

Root cause: there is no display-name mapping anywhere. Labels are hand-written
per call site, so drift recurs with every descriptor append.

## Decisions

1. **Scope: synth2-wide unification.** Matrix dropdowns AND all synth2 knob /
   header labels draw from one shared vocabulary. Other panels untouched.
2. **Pitch vocabulary: Octave + Detune** (the current knob labels; they
   describe the behavior — coarse steps whole octaves, fine spans ±1200 c).
3. **Envelope naming: hybrid number + role.** Headers `ENV 1 · AMP`,
   `ENV 2 · FILTER`, `ENV 3 · MOD`; matrix sources `Env 1 (Amp)` etc.
4. **Dest format: flat compact.** One flat option list, module prefix + short
   param label (`Osc 1 Octave`). No optgroups. Dest labels drop the env role
   suffix (`Env 1 Attack`, not `Env 1 (Amp) Attack`) — the number
   disambiguates once the headers show it.
5. **Label home: the shared descriptor table** (`synth2-descriptors.ts`).
   Presentational fields ride the existing single-source-of-truth table;
   precedent: `LFO_SYNC_LABELS`, `ENV_SYNC_KNOB_LABELS` already live in shared.
   Labels are presentational only — editing them never violates the
   append-only wire rule.

Rejected: client-side label module (splits param definition across two
packages); structured display-metadata module with units/long labels (YAGNI).

## Vocabulary

### Matrix sources

| Wire value | Label |
|---|---|
| `none` | None |
| `lfo1` / `lfo2` | LFO 1 / LFO 2 |
| `env1` | Env 1 (Amp) |
| `env2` | Env 2 (Filter) |
| `env3` | Env 3 (Mod) |
| `velocity` | Velocity |
| `noise` | Noise |

### Matrix dests (flat compact) and knob labels

Dest label = module label + param label; knob shows `shortLabel ?? label`.

| Wire key | Dest label | Knob shows |
|---|---|---|
| `oscN.morph` | Osc N Morph | Morph |
| `oscN.pulseWidth` | Osc N PW | PW |
| `oscN.coarse` | Osc N Octave | Octave |
| `oscN.fine` | Osc N Detune | Detune |
| `oscN.level` | Osc N Level | Level |
| `envN.a/d/s/r` | Env N Attack / Decay / Sustain / Release | A / D / S / R (`shortLabel`) |
| `noise.level` / `noise.color` | Noise Level / Noise Color | Level / Color |
| `fm.osc2` / `fm.osc3` | FM 1→2 / FM 2→3 (no module prefix) | FM 1→2 / FM 2→3 |
| `filter.cutoff` | Filter Cutoff | Cutoff |
| `filter.resonance` | Filter Res | Res |
| `filter.keyTrack` | Filter KeyTrk | KeyTrk |
| `filter.morph` | Filter Morph | Morph |
| `filter.drive` | Filter Drive | Drive |
| `lfoN.rate` / `lfoN.shape` | LFO N Rate / LFO N Shape | Rate / Shape |
| `none` | None | — |

Non-modulatable rows (`osc*.sync`, `filter.type`, `filter.model`,
`filter.envAmount`, `lfo*.sync/div/mode`, `env*.sync/*Div`, `env*.loop`) also
get `label` values for future UI use, but nothing renders them yet.
`filter.envAmount` keeps knob label **EnvAmt** (unchanged; it is not a mod
dest).

### Panel headers

`OSC 1/2/3`, `NOISE`, `FM`, `FILTER`, `LFO 1/2`, `MATRIX` unchanged. The three
envelope headers become **ENV 1 · AMP**, **ENV 2 · FILTER**, **ENV 3 · MOD**,
composed from the env-role table (role written exactly once). The matrix
amount knob stays **Amt**.

Width check: longest dest "Filter Cutoff" (13 ch) and source "Env 2 (Filter)"
(14 ch) fit the 0.65 rem monospace selects at least as well as today's
`filter.resonance` (16 ch).

## Architecture

### Shared (`@fiddle/shared`) — presentational, append-safe

- `Synth2ParamDescriptor` gains **`label: string` (required)** and
  **`shortLabel?: string`** (only the 12 env-stage rows use it). The contract
  test makes omitting `label` on a future append impossible.
- New exports in a sibling **`synth2-labels.ts`** (re-exported from the same
  barrel; keeps the descriptor file focused on the wire contract while the
  per-row `label`/`shortLabel` fields live on the table itself):
  - `SYNTH2_MODULE_LABELS: Record<string, string | null>` — `osc1` → "Osc 1",
    `env1` → "Env 1", `filter` → "Filter", … , `fm` → `null` (no prefix).
  - `MOD_SOURCE_LABELS: Record<Synth2ModSource, string>` — table above.
  - `modDestLabel(key: string): string` — `'none'` → "None"; else module
    label + `' '` + descriptor label; `null` module prefix ⇒ descriptor label
    alone (the fm rows).
  - `SYNTH2_ENV_ROLES: Record<'env1' | 'env2' | 'env3', string>` —
    Amp / Filter / Mod; composed into source labels (`Env 1 (Amp)`) and
    headers (`ENV 1 · AMP`).
- **`MOD_DESTS` / `MOD_SOURCES` are untouched** — they remain the wire /
  persistence encoding. Labels never travel on the wire.

### Client — `Synth2Panel.vue` only

- Matrix `<option>`s render `MOD_SOURCE_LABELS[src]` / `modDestLabel(dst)`
  while keeping the raw key as `value`. Zero change to stored projects, the
  sync protocol, or the kernel.
- Knob `label` props switch from hand-written strings to a lookup
  (`shortLabel ?? label` by descriptor key), so knob text and matrix text
  share one source and cannot drift.
- Envelope headers interpolate from `SYNTH2_ENV_ROLES`.

## Testing

Vitest only; no `.vue` mounting (repo convention).

1. **Descriptor contract test extension:** every descriptor has a non-empty
   `label` containing no `.`; every `MOD_DESTS` entry maps through
   `modDestLabel` to something ≠ the raw key; every `MOD_SOURCES` entry has a
   `MOD_SOURCE_LABELS` entry.
2. **Collision test:** the full dest-label list contains no duplicates (two
   dests must never render identically — the prefix-less FM rows are the
   real risk this guards).

## Risks / notes

- Labels are presentational; old sessions and old clients are unaffected. The
  only behavioral surface is option/knob/header text.
- Append-only rule is about array positions, not row contents — adding fields
  to existing rows is safe.
- Merge gate as usual: `npm run typecheck && npm test && npm run build`, plus
  browser verification of the panel before calling it done.

## Out of scope (candidates for a later pass)

- synth1: OscillatorPanel "Coarse/Fine", FilterPanel "Env Amt" (with space)
  vs synth2 "EnvAmt".
- TrackMixer / Tracker "LEVEL" vs title-case "Level" elsewhere.
