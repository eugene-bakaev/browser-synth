import { NodeSDK } from '@opentelemetry/sdk-node';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BatchLogRecordProcessor } from '@opentelemetry/sdk-logs';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-http';
// The published types use `export = exported` with `FastifyOtelInstrumentation`
// as a named member; with NodeNext + esModuleInterop the named form typechecks.
import { FastifyOtelInstrumentation } from '@fastify/otel';

// The single switch. Off (unset) → no SDK starts, the OTel API hands out no-op
// tracers/meters/loggers, and every instrumentation call elsewhere is free.
// Render/production never sets this, so prod is fully un-instrumented.
export function isOtelEnabled(): boolean {
  return Boolean(process.env.FIDDLE_OTEL);
}

let sdk: NodeSDK | null = null;

// Endpoint, headers, and service name come from OTEL_* env (set by the dev:obs
// script), so nothing is hard-coded and there is no off-machine default.
export function startOtel(): void {
  if (!isOtelEnabled() || sdk) return;
  sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter(),
      exportIntervalMillis: 10_000,
    }),
    logRecordProcessors: [new BatchLogRecordProcessor(new OTLPLogExporter())],
    instrumentations: [
      new FastifyOtelInstrumentation({
        registerOnInitialization: true,
        ignorePaths: (opts) => opts.url.startsWith('/health'),
      }),
    ],
  });
  sdk.start();
}

export async function shutdownOtel(): Promise<void> {
  if (!sdk) return;
  await sdk.shutdown();
  sdk = null;
}
