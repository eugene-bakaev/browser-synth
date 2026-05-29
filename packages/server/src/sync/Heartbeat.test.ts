import { describe, it, expect } from 'vitest';
import { Heartbeat } from './Heartbeat.js';

function mockSocket() {
  return {
    sent: [] as any[],
    closed: false,
    readyState: 1,
    send(m: any) {
      this.sent.push(m);
    },
    close() {
      this.closed = true;
    },
  };
}

describe('Heartbeat', () => {
  it('sends ping on tick', () => {
    const sock = mockSocket();
    const hb = new Heartbeat(sock, () => 0);
    hb.tick();
    expect(sock.sent[0].type).toBe('ping');
  });

  it('does not close while pongs are arriving', () => {
    const sock = mockSocket();
    let now = 0;
    const hb = new Heartbeat(sock, () => now);
    hb.tick(); // t=0, ping
    now = 30_000;
    hb.onPong();
    hb.tick();
    expect(sock.closed).toBe(false);
  });

  it('closes socket on pong timeout', () => {
    const sock = mockSocket();
    let now = 0;
    const hb = new Heartbeat(sock, () => now);
    hb.tick(); // t=0, ping (last pong = 0)
    now = 70_000; // 70s no pong
    hb.tick();
    expect(sock.closed).toBe(true);
  });
});
