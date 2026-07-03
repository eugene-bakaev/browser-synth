// AppRuntime — the composition root. The ONLY place the app's long-lived
// resources (project store, command bus, sync session, audio engine) are
// created, and the ONLY owner of their teardown. main.ts creates one per page
// and wires every lifecycle event (pagehide, HMR) to shutdown(). Tests create
// one per test — fresh, isolated, no module-reset gymnastics.
import { createPinia, type Pinia } from 'pinia';
import type { InjectionKey } from 'vue';
import { useProjectStore } from '../stores/project';
import { createCommandBus, type CommandBus } from '../sync/CommandBus';
import { SyncSession, type WsClientFactory } from '../sync/SyncSession';
import { WsClient } from '../sync/WsClient';
import { AudioEngine } from '../audio/AudioEngine';
import { useAuth } from '../auth/useAuth';

export interface AppRuntimeOptions {
  /** Test seam: hand back a fake WsClient instead of opening real sockets. */
  wsClientFactory?: WsClientFactory;
  /** Test seam: false keeps the WS layer dark (connect only reflects the room id). */
  syncEnabled?: boolean;
}

export interface AppRuntime {
  pinia: Pinia;
  store: ReturnType<typeof useProjectStore>;
  bus: CommandBus;
  session: SyncSession;
  audio: AudioEngine;
  /** Idempotent full teardown: audio (ctx/engines/transport) then sync (socket). */
  shutdown(): void;
}

// Symbol.for (not Symbol()) is HMR-stable — see the sibling rationale on
// SYNTH_CONTEXT in app/synthContext.ts.
export const RUNTIME_KEY: InjectionKey<AppRuntime> = Symbol.for('fiddle:appRuntime');

export function createAppRuntime(opts: AppRuntimeOptions = {}): AppRuntime {
  const pinia = createPinia();
  const store = useProjectStore(pinia);
  const project = store.project;

  // bus ↔ session wiring: the bus needs the session's gated outbound enqueue;
  // the session needs the bus for inbound ops. The arrow late-binds `session`
  // (it only runs on a dispatch, long after both exist).
  let session: SyncSession;
  const bus = createCommandBus({
    applySet: store.applySet,
    loadProject: store.loadProject,
    enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
  });
  session = new SyncSession({
    bus,
    wsClientFactory: () => (opts.wsClientFactory ?? ((o) => new WsClient(o))),
    syncEnabled: () => opts.syncEnabled ?? true,
    auth: () => useAuth(),
  });
  const audio = new AudioEngine({ project, subscribe: bus.subscribe });

  function shutdown(): void {
    audio.dispose();
    session.dispose();
  }

  return { pinia, store, bus, session, audio, shutdown };
}
