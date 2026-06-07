import { describe, it, expect, vi, afterEach } from 'vitest';
import { logs } from '@opentelemetry/api-logs';
import { makeLog } from './log.js';

describe('makeLog', () => {
  afterEach(() => {
    delete process.env.FIDDLE_OTEL;
    vi.restoreAllMocks();
  });

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

  it('does NOT emit an OTel log record when the flag is off (pino only)', () => {
    delete process.env.FIDDLE_OTEL;
    const emit = vi.fn();
    vi.spyOn(logs, 'getLogger').mockReturnValue({ emit } as never);
    const info = vi.fn();
    const log = makeLog({ log: { info } } as never);

    log('client live', { roomId: 'r1' });

    expect(info).toHaveBeenCalledWith({ roomId: 'r1' }, 'client live');
    expect(emit).not.toHaveBeenCalled();
  });

  it('also emits a trace-correlated OTel INFO record when the flag is on', () => {
    process.env.FIDDLE_OTEL = '1';
    const emit = vi.fn();
    vi.spyOn(logs, 'getLogger').mockReturnValue({ emit } as never);
    const info = vi.fn();
    const log = makeLog({ log: { info } } as never);

    log('client live', { roomId: 'r1' });

    // pino still fires unconditionally, AND the OTel record is emitted.
    expect(info).toHaveBeenCalledWith({ roomId: 'r1' }, 'client live');
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        severityText: 'INFO',
        body: 'client live',
        attributes: { roomId: 'r1' },
      }),
    );
  });
});
