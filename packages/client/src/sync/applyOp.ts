// Suppression flag (transitional) — slated for deletion in Phase 2b-iii.
//
// While the OUTBOUND sync watchers in useSynth.ts still observe the reactive
// `project`, any programmatic (network-origin) write — the inbound
// CommandBus.applyRemote, the snapshot replaceProject, the Outbox rollback —
// must be wrapped so those watchers don't echo it straight back out. This flag
// is that switch: it is true for the duration of such a write, and each
// sync-participating watcher checks `isApplyingFromNetwork` before enqueuing.
//
// This only works because those watchers run with `flush: 'sync'` — they fire
// synchronously inside the suppressed write, while the flag is still held.
//
// Phase 2b-iii deletes this once every outbound write goes through the
// CommandBus (dispatchLocal) and no watcher remains to suppress.
let applyingFromNetwork = false;
export function isApplyingFromNetwork(): boolean { return applyingFromNetwork; }
export function enterSuppress(): void { applyingFromNetwork = true; }
export function exitSuppress(): void { applyingFromNetwork = false; }
