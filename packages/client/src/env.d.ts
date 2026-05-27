/// <reference types="vite/client" />

// Vite resolves `?url` imports to the served asset URL string. The worklet
// is loaded via `audioContext.audioWorklet.addModule(url)` at runtime, so we
// only need the URL — not the module's exports.
declare module '*.js?url' {
  const src: string;
  export default src;
}
