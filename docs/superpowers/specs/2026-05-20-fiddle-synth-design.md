# Fiddle Synth: Modular Sound Playground Design

A browser-based sound playground featuring a modular synthesizer engine and a tracker-style sequencer.

## 1. Vision & Goals
A "fiddling" environment where the internal routing is decoupled from the UI, allowing for future architectural changes.

## 2. Architecture: Node Graph & Patch Bay
### 2.2 Modules
1.  **Oscillator (x2):** Sine, Square, Saw, Triangle. Controls: Coarse Tune (-3 to +3), Fine Tune (-100 to +100).
2.  **Mixer:** 2 Independent channels with independent gain controls summing to main.
3.  **Filter:** 24dB/oct Low-pass. Controls: Cutoff Frequency, Resonance.
4.  **Envelope (x2):** ADSR. Env 1 (VCA), Env 2 (Filter).

## 3. Sequencer: Tracker-Style
- 16 steps. Each step contains: `note`, `octave`, `length`.

## 4. User Interface
- **Sequencer Section:** A strict VERTICAL scrolling tracker layout with column headers (STEP | NOTE | OCT | LEN).
- **Engine Section:**
    - Oscillators: Type, Coarse, Fine
    - Mixer: Osc 1 Level, Osc 2 Level
    - Filter: Cutoff, Res
    - Filter Env: A, D, S, R
    - Amp Env: A, D, S, R

## 5. Technology Stack
- Vite, Vue.js, Vanilla Web Audio API, TypeScript, Vanilla CSS.