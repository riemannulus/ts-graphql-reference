import { isSpanContextValid, trace } from '@opentelemetry/api';

/**
 * The logging seam — a structural subset of Fastify's pino logger (`app.log` /
 * `req.log`), the same discipline `SchedulerLogger` uses. A resolver or service
 * receives a `Logger` (never the concrete pino type), so the composition root
 * can bind the real request logger while a test binds a recording fake. The one
 * house idiom is object-first — `logger.info({ userId }, 'message')` — so the
 * structured fields stay queryable; a bare `logger.info('message')` is allowed
 * for a payload-free line.
 *
 * pino's `FastifyBaseLogger` satisfies this by construction, so `req.log` flows
 * in with no adapter.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  debug(msg: string): void;
  info(obj: object, msg?: string): void;
  info(msg: string): void;
  warn(obj: object, msg?: string): void;
  warn(msg: string): void;
  error(obj: object, msg?: string): void;
  error(msg: string): void;
  /** Derive a child logger with permanently-bound fields (e.g. a request id). */
  child(bindings: object): Logger;
  /**
   * True when `level` would actually be emitted. Lets a caller skip building an
   * expensive payload (e.g. a deep-redacted variables object) for a line that
   * would be dropped. Optional so a minimal recording fake need not implement it
   * — a caller guards with `logger.isLevelEnabled?.(…)`, which then skips the work.
   */
  isLevelEnabled?(level: string): boolean;
}

/**
 * The known deploy log levels, most→least severe. `silent` disables output.
 * A value set (parse, don't validate) so an unknown `LOG_LEVEL` can neither be
 * silently honored nor crash the logger.
 */
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Parse, don't validate: the raw `LOG_LEVEL` env var becomes a `LogLevel` only
 * here. Unknown / null / undefined → `'info'`, the safe default (crepe froze the
 * level at `'info'` by never setting it; this makes it a runtime knob without
 * losing that default). Mirrors `parseStage`.
 */
export function parseLogLevel(value: string | null | undefined): LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value)
    ? (value as LogLevel)
    : 'info';
}

/**
 * pino `redact` paths for fixed-shape header PII. These are the single,
 * fail-closed choke point for header secrets: static paths are cheap and
 * compiled from constants only (never user input). They deliberately do NOT
 * reach dynamic GraphQL variables — those are redacted by key name in the
 * operation-log plugin (see graphql/plugins/operation-log.ts), a separate
 * mechanism. Case-sensitive, so list the header casing Fastify serializes.
 */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
];

/**
 * pino `mixin`: stamps the active OpenTelemetry trace/span id onto every log
 * line, so a log and its trace share one key (the "three pillars stitched by a
 * trace id" that crepe lacked entirely). Returns `{}` when no span is active
 * (no OTel SDK started — tests, or a bare `tsx src/server.ts` without the
 * `--import` bootstrap), so it is a no-op rather than a hazard in those paths.
 *
 * NOTE: `getActiveSpan()` reads OTel's AMBIENT (AsyncLocalStorage-backed)
 * context — a deliberate, bounded exception to this repo's explicit-injection
 * rule, confined to this telemetry-edge helper. Domain code (core/repo/service)
 * never reads ambient state; it receives the `Logger` port by injection.
 */
export function traceContextMixin(): Record<string, string> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  // `isSpanContextValid` rejects the all-zero context of a non-recording span —
  // which is what an active instrumentation produces when no tracer provider is
  // registered (the no-OTLP-endpoint path). So logs get a real trace id or none,
  // never a `0000…0` placeholder.
  if (!spanContext || !isSpanContextValid(spanContext)) return {};
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}
