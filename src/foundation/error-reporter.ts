import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';

/**
 * The error-tracking seam — a narrow port (one method), the same shape
 * discipline as `Clock` / `SchedulerLogger`. It is wired at exactly the
 * *unexpected-error* boundaries (Yoga's `maskError` masked branch, the OAuth
 * route's catch, the scheduler's `fail`/`error` events); expected `DomainError`s
 * are never reported. Service and core code stay vendor-free — they throw typed
 * errors and know nothing about this port.
 *
 * The lesson from crepe (OBS-02/06/11): capture at boundaries, keep it
 * vendor-neutral, and never hardcode a vendor DSN in source. The production
 * binding is `otelErrorReporter` (records the exception on the active span, so
 * any OTLP backend — Sentry included, as an OTLP consumer — receives it); the
 * default is a no-op so the reference runs, and every test passes, with no
 * external service.
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
