import { isSpanContextValid, type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';

/**
 * The error-tracking seam — a narrow port (one method), the same shape
 * discipline as `Clock` / `SchedulerLogger`. It is wired at exactly the
 * *unexpected-error* boundaries (Yoga's `maskError` masked branch, the OAuth
 * route's catch, the scheduler's `fail`/`error` events); expected `DomainError`s
 * are never reported. Service and core code stay vendor-free — they throw typed
 * errors and know nothing about this port.
 *
 * The lesson from crepe (OBS-02/06/11): capture at boundaries, keep it
 * vendor-neutral, and never hardcode a vendor DSN in source. Bindings:
 * - `noopErrorReporter` — default; errors are still logged at their boundary.
 * - `otelErrorReporter` — records the exception on the active span (a trace
 *   backend like Jaeger shows it; Sentry-over-OTLP does NOT, as it drops span
 *   events).
 * - `sentryErrorReporter()` — a real, grouped Sentry Issue via `@sentry/node`.
 * - `compositeErrorReporter(...)` — fan out to several of the above.
 * The composition root (server.ts) picks the binding from env; the default runs
 * the reference, and every test, with no external service.
 */
export interface ErrorReporter {
  /** Report an unexpected error. `context` carries small, non-sensitive tags. */
  capture(error: unknown, context?: Record<string, unknown>): void;
}

/** The default binding: does nothing. Errors are still logged at their boundary. */
export const noopErrorReporter: ErrorReporter = {
  capture() {},
};

/**
 * Records the error as an exception event on the active OpenTelemetry span and
 * marks the span failed, so it travels the same OTLP pipeline as traces (no
 * separate error-tracker SDK, no DSN). When no span is active — no SDK started
 * — it degrades to the no-op, matching every other OTel seam here.
 *
 * Like the log trace-id mixin, `getActiveSpan()` reads OTel's ambient
 * (AsyncLocalStorage) context — the same deliberate, telemetry-edge-only
 * exception to explicit injection; callers still receive this port by injection.
 */
export const otelErrorReporter: ErrorReporter = {
  capture(error, context) {
    const span: Span | undefined = trace.getActiveSpan();
    if (!span) return;
    const err = error instanceof Error ? error : new Error(String(error));
    span.recordException(err);
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    if (context) {
      for (const [key, value] of Object.entries(context)) {
        // Only low-cardinality scalar tags belong on a span attribute.
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
          span.setAttribute(`app.${key}`, value);
        }
      }
    }
  },
};

/**
 * Reports to Sentry as a proper Issue via `@sentry/node`. Unlike the OTLP-trace
 * path (Sentry drops span events, so `recordException` never becomes an Issue),
 * `captureException` creates a real, grouped Issue. The Sentry client is set up
 * error-only in server.ts (`skipOpenTelemetrySetup: true`), so this coexists with
 * the app's own NodeSDK without either owning the global tracer.
 *
 * The active OTel `trace_id` is attached as a tag so a Sentry Issue links back to
 * its trace — manual correlation that needs none of Sentry's OTel adapters (we
 * never touch a Sentry scope, so there is no cross-request scope-bleed risk).
 */
export function sentryErrorReporter(): ErrorReporter {
  return {
    capture(error, context) {
      const spanContext = trace.getActiveSpan()?.spanContext();
      const traceId = spanContext && isSpanContextValid(spanContext) ? spanContext.traceId : undefined;
      Sentry.captureException(error, {
        ...(context ? { extra: context } : {}),
        ...(traceId ? { tags: { trace_id: traceId } } : {}),
      });
    },
  };
}

/**
 * Fans one report out to several reporters (e.g. record on the OTel span AND
 * send to Sentry). Each backend then receives the error in its native form —
 * the span event for a trace backend like Jaeger, a grouped Issue for Sentry.
 */
export function compositeErrorReporter(...reporters: ErrorReporter[]): ErrorReporter {
  return {
    capture(error, context) {
      for (const reporter of reporters) {
        // Isolate reporters: one that throws must neither skip the others nor
        // propagate out of the error boundary that called us. This is the
        // last-resort reporter — there is nowhere better to send its own
        // failure — so the throw is intentionally swallowed.
        try {
          reporter.capture(error, context);
        } catch {
          // ignore: a failing reporter must not break error handling
        }
      }
    },
  };
}
