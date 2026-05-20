# Fiddle Synth: Modular Sound Playground Design

A browser-based sound playground featuring a modular synthesizer engine and a tracker-style sequencer.

## 1. Vision & Goals
A "fiddling" environment where the internal routing is decoupled from the UI, allowing for future architectural changes (like FM synthesis or sync) while providing a fixed, intuitive dashboard for immediate experimentation.

## 2. Architecture: Node Graph & Patch Bay
The core of the system is a **Node Graph** approach, mirroring the native Web Audio API.

### 2.1 Patch Bay Logic
- Modules are independent wrappers around `AudioNode`s.
- Modules expose **Input**, **Output**, and **Parameter** ports.
- A `PatchBay` manages the connections between these ports based on a `PatchMap` configuration.

### 2.2 Modules
1.  **Oscillator (x2):**
    - Waveforms: Sine, Square, Saw, Triangle.
    - Controls: Coarse Tune (Octave), Fine Tune (Detune).
2.  **Mixer:**
    - Sums inputs from both oscillators.
    - Individual gain/level controls for each source.
3.  **Filter:**
    - Type: 24dB/oct Low-pass.
    - Controls: Cutoff Frequency, Resonance.
4.  **Envelope (x2):**
    - Type: ADSR (Attack, Decay, Sustain, Release).
    - **Env 1 (VCA):** Hardwired to modulate the master volume.
    - **Env 2 (Filter):** Hardwired to modulate the Filter Cutoff.

## 3. Sequencer: Tracker-Style
A decoupled 16-step sequencer that triggers the synth engine.

### 3.1 Step Data Structure
Each of the 16 steps contains:
- `note`: e.g., "C", "D#", or `null`.
- `octave`: 0-8.
- `length`: Duration in ticks.

### 3.2 Timing
- Uses `requestAnimationFrame` or a Web Worker for stable "on-the-beat" scheduling.
- Decoupled from the synth: the sequencer just sends `noteOn(freq, duration)` and `noteOff()` signals to the engine.

## 4. User Interface
A fixed-layout dashboard for "knob-fiddling."

- **Sequencer Section:** A 16-step grid where users can input notes and octaves.
- **Engine Section:**
    - Osc 1 & 2 controls (Waveform, Tune).
    - Mixer levels.
    - Filter Cutoff & Resonance.
    - Two sets of ADSR sliders.

## 5. Technology Stack
- **Build Tool:** Vite (for fast development and module bundling).
- **Frontend Framework:** Vue.js (for reactive UI and state management).
- **Audio Engine:** Vanilla Web Audio API (decoupled from Vue).
- **Language:** TypeScript (for robust modular architecture).
- **Styling:** Vanilla CSS.

## 6. Future Extensibility
The "Node Graph" approach allows for:
- **FM Synthesis:** Routing Osc 1 output to Osc 2 Frequency.
- **LFOs:** Adding low-frequency oscillators to modulate any parameter.
- **Effects:** Inserting Delay or Reverb modules into the Patch Map.
