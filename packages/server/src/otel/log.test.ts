import { describe, it, expect, vi } from 'vitest';
import { makeLog } from './log.js';

describe('makeLog', () => {
  it('forwards message + fields to the Fastify pino logger', () => {
    const info = vi.fn();
    const fakeApp = { log: { info } } as never;
    const log = makeLog(fakeApp);

    log('guest session pruned on empty', { roomId: 'r1' });

    expect(info).toHaveBeenCalledWith({ roomId: 'r1' }, 'guest session pruned on empty');
  });

  it('uses an empty object when no fields are given and does not throw', () => {
    const info = vi.fn();
    const fakeApp = { log: { info } } as never;
    const log = makeLog(fakeApp);

    expect(() => log('server up')).not.toThrow();
    expect(info).toHaveBeenCalledWith({}, 'server up');
  });
});
