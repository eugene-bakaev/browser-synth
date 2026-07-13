// AppRuntime — the composition root. The ONLY place the app's long-lived
// resources (project store, command bus, sync session, audio engine) are
// created, and the ONLY owner of their teardown. main.ts creates one per page
// and wires every lifecycle event (pagehide, HMR) to shutdown(). Tests create
// one per test — fresh, isolated, no module-reset gymnastics.
import { createPinia, type Pinia } from 'pinia';
import type { InjectionKey } from 'vue';
import { getDeep } from '@fiddle/shared';
import { useProjectStore } from '../stores/project';
import { createCommandBus, type CommandBus } from '../sync/CommandBus';
import { SyncSession, type WsClientFactory } from '../sync/SyncSession';
import { WsClient } from '../sync/WsClient';
import { gestureEndForLeaf } from '../sync/dispatchPolicy';
import { AudioEngine } from '../audio/AudioEngine';
import { useAuth } from '../auth/useAuth';
import { KeyboardService } from '../keyboard/KeyboardService';
import { createUndoHistory, type UndoHistory } from './undoHistory';

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
  keyboard: KeyboardService;
  history: UndoHistory;
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

  // history ↔ bus wiring mirrors the bus ↔ session pattern below: the arrows
  // late-bind busRef (they only run on user input, long after both exist).
  let busRef: CommandBus;
  const history = createUndoHistory({
    getLiveValue: (path) => getDeep(project as unknown as Record<string, unknown>, path),
    dispatch: (path, value, priorValue) => busRef.dispatchLocal({
      path, value, priorValue,
      gestureEnd: gestureEndForLeaf(String(path[path.length - 1])),
    }),
  });

  // bus ↔ session wiring: the bus needs the session's gated outbound enqueue;
  // the session needs the bus for inbound ops. The arrow late-binds `session`
  // (it only runs on a dispatch, long after both exist).
  let session: SyncSession;
  const bus = createCommandBus({
    applySet: store.applySet,
    // History never spans projects: New/Open/snapshot/room switch clear it.
    loadProject: (next) => { store.loadProject(next); history.clear(); },
    enqueue: (path, value, prior, gestureEnd) => session.enqueue(path, value, prior, gestureEnd),
    onLocalCommand: history.record,
  });
  busRef = bus;
  session = new SyncSession({
    bus,
    wsClientFactory: () => (opts.wsClientFactory ?? ((o) => new WsClient(o))),
    syncEnabled: () => opts.syncEnabled ?? true,
    auth: () => useAuth(),
  });
  const audio = new AudioEngine({ project, subscribe: bus.subscribe });
  const keyboard = new KeyboardService();

  // App-global undo/redo. Registered here (not in a view) because the history
  // is page-lifetime; keyboard.dispose() in shutdown() drops the registrations.
  keyboard.register({
    id: 'global.undo', description: 'Undo last edit', context: 'global',
    allowRepeat: true, focusIndependent: true,
    isEnabled: () => history.canUndo(), run: () => history.undo(),
  });
  keyboard.register({
    id: 'global.redo', description: 'Redo last undone edit', context: 'global',
    allowRepeat: true, focusIndependent: true,
    isEnabled: () => history.canRedo(), run: () => history.redo(),
  });

  function shutdown(): void {
    keyboard.dispose();
    audio.dispose();
    session.dispose();
  }

  return { pinia, store, bus, session, audio, keyboard, history, shutdown };
}
