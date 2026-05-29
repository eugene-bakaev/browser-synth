// Per-socket liveness check. Server sends a `ping` every 30 s; if no `pong`
// arrives within 60 s of the last pong (i.e. two consecutive misses), the
// socket is closed with 1011 (Internal Error). The `nowFn` injection lets
// tests drive time deterministically without faking timers.

import type { PingMessage } from '@fiddle/shared';
import type { SocketLike } from './SocketLike.js';

const PING_INTERVAL_MS = 30_000;
const TIMEOUT_MS = 60_000;

export class Heartbeat {
  private timer: NodeJS.Timeout | null = null;
  private lastPongAt: number;

  constructor(
    private readonly socket: SocketLike,
    private readonly nowFn: () => number = Date.now,
  ) {
    // Seed via nowFn so tests passing a fake clock start with lastPongAt
    // anchored to that clock — otherwise timeout math against `() => 0`
    // would compare against real wall-clock time.
    this.lastPongAt = nowFn();
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), PING_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  onPong(): void {
    this.lastPongAt = this.nowFn();
  }

  // Public so tests can step the heartbeat without leaning on fake timers.
  // Production path: invoked by setInterval started in `start`.
  tick(): void {
    if (this.nowFn() - this.lastPongAt > TIMEOUT_MS) {
      this.socket.close(1011, 'pong timeout');
      this.stop();
      return;
    }
    const ping: PingMessage = { v: 1, type: 'ping' };
    this.socket.send(ping);
  }
}
