import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installProcessSafetyNet } from './processSafetyNet.js';

describe('installProcessSafetyNet', () => {
  it('logs an unhandled rejection instead of letting it crash the process', () => {
    const proc = new EventEmitter();
    const log = vi.fn();
    installProcessSafetyNet(log, proc);

    // Node terminates the process on an unhandled rejection by default; with the
    // net installed the rejection is observed (a listener exists) and logged.
    proc.emit('unhandledRejection', new Error('boom'), Promise.resolve());

    expect(log).toHaveBeenCalledTimes(1);
    const [msg, ctx] = log.mock.calls[0]!;
    expect(msg.toLowerCase()).toContain('unhandled');
    expect((ctx as { err: { message: string } }).err.message).toBe('boom');
  });

  it('registers exactly one unhandledRejection listener', () => {
    const proc = new EventEmitter();
    installProcessSafetyNet(vi.fn(), proc);
    expect(proc.listenerCount('unhandledRejection')).toBe(1);
  });

  it('does not swallow uncaughtException (a real sync bug must still crash)', () => {
    const proc = new EventEmitter();
    installProcessSafetyNet(vi.fn(), proc);
    expect(proc.listenerCount('uncaughtException')).toBe(0);
  });
});
