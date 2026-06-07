import { trace, metrics, SpanStatusCode } from '@opentelemetry/api';
import type { Project } from '@fiddle/shared';
import type { SessionStore } from '../session/SessionStore.js';
import type { ProfileStore } from '../profile/ProfileStore.js';
import { isOtelEnabled } from './sdk.js';

const TRACER = 'fiddle-db';

// Lazily created so they bind to the real MeterProvider (installed by
// startOtel) on first use. Without an SDK these are no-op instruments.
let callsInst: ReturnType<ReturnType<typeof metrics.getMeter>['createCounter']> | null = null;
let durInst: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null = null;
let bytesInst: ReturnType<ReturnType<typeof metrics.getMeter>['createHistogram']> | null = null;
function calls() {
  return (callsInst ??= metrics.getMeter(TRACER).createCounter('fiddle.db.calls'));
}
function duration() {
  return (durInst ??= metrics.getMeter(TRACER).createHistogram('fiddle.db.duration_ms', { unit: 'ms' }));
}
function blobBytes() {
  return (bytesInst ??= metrics.getMeter(TRACER).createHistogram('fiddle.db.blob_bytes', { unit: 'By' }));
}

// Serialized byte size — only computed when OTel is on (avoids stringifying the
// ~224 KB project on every snapshot op in prod).
function blob(value: unknown): number {
  if (!isOtelEnabled()) return 0;
  return Buffer.byteLength(JSON.stringify(value));
}

interface DbSpanOpts<T> {
  rowsOf?: (result: T) => number;
  sizeOf?: (result: T) => number; // bytes derived from the result
  inputBytes?: number; // bytes of the input payload (writes)
}

// Wrap one DB call: child span + duration/call metrics, plus optional row count
// and blob-byte size. A no-op tracer/meter (flag off) makes this nearly free.
export async function withDbSpan<T>(
  op: string,
  exec: () => Promise<T>,
  opts: DbSpanOpts<T> = {},
): Promise<T> {
  const tracer = trace.getTracer(TRACER);
  const start = performance.now();
  return tracer.startActiveSpan(`db ${op}`, async (span) => {
    span.setAttribute('db.op', op);
    try {
      const result = await exec();
      const ms = performance.now() - start;
      calls().add(1, { 'db.op': op });
      duration().record(ms, { 'db.op': op });
      span.setAttribute('db.duration_ms', ms);
      if (opts.rowsOf) span.setAttribute('db.rows', opts.rowsOf(result));
      if (isOtelEnabled()) {
        const bytes = opts.sizeOf ? opts.sizeOf(result) : opts.inputBytes ?? 0;
        if (bytes > 0) {
          span.setAttribute('db.blob_bytes', bytes);
          blobBytes().record(bytes, { 'db.op': op });
        }
      }
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

// Transparent wrapper: same SessionStore contract, every call instrumented.
// Applied to the in-memory and Postgres stores alike (no-op when flag off).
export function instrumentSessionStore(inner: SessionStore): SessionStore {
  return {
    create: (input) =>
      withDbSpan('sessions.create', () => inner.create(input), { inputBytes: blob(input.project) }),
    get: (id) => withDbSpan('sessions.get', () => inner.get(id), { rowsOf: (r) => (r ? 1 : 0) }),
    list: () => withDbSpan('sessions.list', () => inner.list(), { rowsOf: (r) => r.length }),
    getSnapshot: (id) =>
      withDbSpan('sessions.getSnapshot', () => inner.getSnapshot(id), {
        sizeOf: (r: Project | null) => (r ? blob(r) : 0),
      }),
    saveSnapshot: (id, project) =>
      withDbSpan('sessions.saveSnapshot', () => inner.saveSnapshot(id, project), {
        inputBytes: blob(project),
      }),
    updateMeta: (id, patch) => withDbSpan('sessions.updateMeta', () => inner.updateMeta(id, patch)),
    delete: (id) => withDbSpan('sessions.delete', () => inner.delete(id)),
  };
}

export function instrumentProfileStore(inner: ProfileStore): ProfileStore {
  return {
    getUsername: (userId) =>
      withDbSpan('profiles.getUsername', () => inner.getUsername(userId), {
        rowsOf: (r) => (r ? 1 : 0),
      }),
  };
}
