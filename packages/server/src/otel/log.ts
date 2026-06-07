import { logs, SeverityNumber } from '@opentelemetry/api-logs';
import type { AnyValueMap } from '@opentelemetry/api-logs';
import type { FastifyInstance } from 'fastify';
import type { Log } from '../sync/ConnectionHandler.js';
import { isOtelEnabled } from './sdk.js';

// Builds the Log callback the SessionSync + ws route use. Always writes to the
// existing pino logger; when OTel is on, also emits a trace-correlated OTel log
// record so domain events ("guest session pruned", "session flush failed",
// "client live") show up in OpenObserve alongside traces. No-op emit otherwise.
export function makeLog(app: FastifyInstance): Log {
  return (message, ctx) => {
    app.log.info(ctx ?? {}, message);
    if (!isOtelEnabled()) return;
    logs.getLogger('fiddle-server').emit({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      body: message,
      // ctx values are always simple domain scalars; cast to satisfy OTel's
      // AnyValueMap (which uses a recursive AnyValue union instead of unknown).
      attributes: ctx as AnyValueMap | undefined,
    });
  };
}
