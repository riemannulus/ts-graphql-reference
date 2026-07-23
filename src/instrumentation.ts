// Load .env BEFORE anything reads process.env. This file is loaded via
// `node --import ./dist/instrumentation.js` (see package.json scripts), so it
// runs before src/server.ts and its env import — hence it loads env itself.
import './foundation/env.js';

import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { PgInstrumentation } from '@opentelemetry/instrumentation-pg';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

/**
 * OpenTelemetry bootstrap — the single, vendor-neutral instrumentation layer the
 * three pillars share (traces + metrics; logs join them via the trace-id mixin
 * in foundation/logger.ts). It replaces crepe's four competing metric sinks and
 * Sentry-locked tracing with ONE pipeline that any OTLP backend consumes.
 *
 * LOAD ORDER IS LOAD-BEARING: OTel patches `http`/`pg` as they are imported, so
 * this must run before those modules load — hence `--import` (see the `dev` /
 * `start` scripts), and, as a fallback, server.ts imports this before `./app.js`.
 * `http` and `pg` are CommonJS, so require-in-the-middle patches them at require
 * time and they ARE instrumented even on a bare `node dist/server.js`. `--import`
 * remains the supported path: instrumenting an ESM-NATIVE library needs the
 * import-in-the-middle loader hook installed before the module graph is built,
 * which only `--import` (not an in-process import) can do.
 *
 * Both exporters are OPTIONAL so the reference runs on Postgres alone:
 * - Traces export only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (point it at the
 *   collector in docker-compose.observability.yml). Unset → NO tracer provider is
 *   registered (see the explicit-empty-array note below), so spans are genuine
 *   no-ops, zero overhead, and the app is unaffected.
 * - Metrics are served at `/metrics` on their OWN port (default 9464), never the
 *   public GraphQL port, and never behind an obscure path (crepe's OBS-12). In
 *   production keep this port off the public internet (network policy); it is a
 *   scrape target, not an API. Disable with `METRICS_ENABLED=false`.
 */
const otlpEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
const metricsEnabled = process.env.METRICS_ENABLED !== 'false';
const parsedPort = Number(process.env.METRICS_PORT);
const metricsPort = Number.isFinite(parsedPort) ? parsedPort : 9464;

const prometheusExporter = metricsEnabled
  ? new PrometheusExporter({
      port: metricsPort,
      // Unset → bind all interfaces, which the docker-compose Prometheus needs to
      // scrape the host across the bridge network (loopback would block it). Set
      // METRICS_HOST=127.0.0.1 to lock the scrape endpoint to loopback where
      // nothing external scrapes it. Either way it is a separate, non-public port.
      host: process.env.METRICS_HOST,
    })
  : undefined;

const sdk = new NodeSDK({
  resource: resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME ?? 'gannet',
    [ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? '0.0.0',
    'deployment.environment': process.env.STAGE ?? 'local',
  }),
  // Pass an explicit EMPTY array when unset — NOT an omitted key. NodeSDK reads a
  // MISSING traceExporter/metricReaders as "use the env default", which for OTel
  // is OTLP-over-localhost:4318 — so omitting would silently register a real
  // provider and retry-fail exporting to a dead local endpoint. An empty array is
  // "configured with zero" → no provider registered → the API tracer/meter stay
  // genuine no-ops until an endpoint is configured.
  ...(otlpEndpoint
    ? { traceExporter: new OTLPTraceExporter() } // reads OTEL_EXPORTER_OTLP_ENDPOINT (+ /v1/traces)
    : { spanProcessors: [] }),
  metricReaders: prometheusExporter ? [prometheusExporter] : [],
  instrumentations: [
    // HTTP server/client spans (the Fastify request is an http span).
    new HttpInstrumentation(),
    // SQL spans. Prisma 7's driver adapter (@prisma/adapter-pg) runs on `pg`,
    // so instrumenting `pg` captures the actual queries reliably — more so than
    // @prisma/instrumentation, which the driver-adapter path does not always
    // surface. Prisma-level spans can be added later if that changes.
    new PgInstrumentation(),
  ],
});

sdk.start();

let shuttingDown: Promise<void> | undefined;

/**
 * Flush and stop the SDK — called from server.ts's SIGTERM/SIGINT handler as the
 * LAST step, so the final seconds of buffered spans/metrics are not dropped on
 * exit. Timeboxed so a stuck exporter cannot outrun the platform's termination
 * grace period. Idempotent.
 */
export function shutdownTelemetry(timeoutMs = 2000): Promise<void> {
  shuttingDown ??= Promise.race([
    sdk.shutdown().catch(() => {}),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
  ]);
  return shuttingDown;
}
