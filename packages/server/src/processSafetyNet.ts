import type { Log } from './sync/ConnectionHandler.js';

/**
 * Last-resort guard so an async error we cannot wrap at the call site can't take
 * the whole sync server down.
 *
 * porsager/postgres emits its own unhandled rejection on a fatal pooler /
 * connection error (ECHECKOUTTIMEOUT, EDBHANDLEREXITED, CONNECTION_CLOSED),
 * separate from the awaited query promise — so the route's try/await already
 * returned a clean 500, yet a second, uncatchable rejection still escapes.
 * Node terminates the process on an unhandled rejection by default; for a
 * long-lived server that's the wrong trade — it turns a transient DB blip into
 * a crash-restart loop. We log loudly and stay up; the next request succeeds
 * once the DB recovers.
 *
 * `uncaughtException` is intentionally NOT handled here: a synchronous
 * programming error leaves the process in an indeterminate state and should
 * still crash (the platform restarts it).
 *
 * `proc` is injectable so tests can drive it without touching the real process.
 */
export function installProcessSafetyNet(
  log: Log,
  proc: NodeJS.EventEmitter = process,
): void {
  proc.on('unhandledRejection', (reason: unknown) => {
    const err =
      reason instanceof Error
        ? { message: reason.message, stack: reason.stack }
        : { message: String(reason) };
    log('unhandled promise rejection (process kept alive)', { err });
  });
}
