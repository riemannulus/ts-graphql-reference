import { metrics } from '@opentelemetry/api';
import { getOperationAST } from 'graphql';
import type { Plugin } from 'graphql-yoga';
import type { Logger } from '../../foundation/logger.js';

/**
 * Substrings (matched after lowercasing and stripping separators) that mark a
 * variable value sensitive. SUBSTRING, not exact-name, match — so compound keys
 * like `accessToken`, `refreshToken`, `apiKey`, `clientSecret`, `confirmPassword`
 * are caught, which an exact-name set silently misses. Still a heuristic: a
 * secret under a key matching none of these is not caught, which is exactly why
 * variables are logged only at `debug`, never at `info`, and always through this
 * redactor. (crepe's OBS-01: its denylist ran on the query path only and left the
 * subscription path unmasked.) Short/collision-prone terms (`pin`, bare `auth`)
 * are deliberately omitted to avoid over-redacting names like `shipping`/`author`.
 */
const SENSITIVE_SUBSTRINGS = [
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'authorization',
  'cookie',
  'credential',
  'privatekey',
  'ssn',
];

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SENSITIVE_SUBSTRINGS.some((s) => normalized.includes(s));
}

/** Recursively replace sensitive values by key name, at every operation type. */
function redactVariables(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactVariables);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, val]) =>
        isSensitiveKey(key) ? [key, '[REDACTED]'] : [key, redactVariables(val)],
      ),
    );
  }
  return value;
}

// One bounded-cardinality metric: duration by operation TYPE and status only —
// never `operationName` (client-controlled → unbounded series → crepe's OBS-04).
// The high-cardinality name rides in the log line below, where it is a field.
const meter = metrics.getMeter('gannet-graphql');
// Unit is SECONDS to match OTel semantic conventions (and the HTTP instrumentation's
// `http.server.request.duration`, also seconds) so both read consistently on the
// same /metrics endpoint. The human-facing log line still reports milliseconds.
const operationDuration = meter.createHistogram('graphql.server.operation.duration', {
  unit: 's',
  description: 'GraphQL operation duration in seconds, labelled by operation type and status.',
});

/**
 * Emits exactly ONE structured line per GraphQL operation (metadata only — never
 * the raw response body, and variables only at `debug`, redacted) and records
 * the bounded operation-duration metric. Logging flows through the request-scoped
 * `ctx.logger` (see graphql/context.ts), so every line carries the request id and
 * — once an OTel span is active — its trace id.
 *
 * Registered first in the Yoga `plugins` array (app.ts) so it is the outermost
 * wrapper and the single per-request record; Fastify's own request logging is
 * left off (`disableRequestLogging` is unnecessary here because Fastify's route
 * log is not the per-operation record). This is the seam where a production app
 * would reuse Yoga's parse result instead of the inline parse in context.ts.
 *
 * NOTE: this schema is query/mutation only, so there is no `onSubscribe` handler.
 * If subscriptions are added, route their variables through the SAME
 * `redactVariables` here rather than adding a second, divergent path.
 */
export function useOperationLog(): Plugin {
  return {
    onExecute({ args }) {
      const startedAt = performance.now();
      const logger = (args.contextValue as { logger?: Logger }).logger;
      const operation = getOperationAST(args.document, args.operationName ?? undefined);
      const operationType = operation?.operation ?? 'other';
      const operationName = args.operationName ?? operation?.name?.value ?? 'anonymous';

      return {
        onExecuteDone({ result }) {
          // Incremental (@defer/@stream) results arrive as an async iterator;
          // this schema has none, so skip rather than log a partial line.
          if (Symbol.asyncIterator in Object(result)) return;

          const errorCount = 'errors' in result ? (result.errors?.length ?? 0) : 0;
          const status = errorCount > 0 ? 'error' : 'ok';
          const durationMs = Number((performance.now() - startedAt).toFixed(1));

          operationDuration.record(durationMs / 1000, {
            'graphql.operation.type': operationType,
            'graphql.operation.status': status,
          });

          const line = {
            gqlOperationName: operationName,
            gqlOperationType: operationType,
            durationMs,
            errorCount,
          };
          // Variables only at debug, always redacted — never full payloads at
          // info. The recursive redaction is built ONLY when debug is actually
          // enabled, so the hot path pays nothing at info/prod levels.
          if (logger?.isLevelEnabled?.('debug')) {
            logger.debug(
              { ...line, variables: redactVariables(args.variableValues ?? {}) },
              'graphql operation (debug)',
            );
          }
          if (errorCount > 0) {
            // These are the PRE-mask errors (this plugin runs before Yoga's
            // maskError), logged server-side at warn for diagnostics — client
            // masking is a separate concern. They are NOT redacted, and the same
            // unmasked content is also recorded on the OTel span by
            // @envelop/opentelemetry, which exports it to the trace backend over
            // the network when OTLP export is on. So a resolver/domain error
            // message must never carry a secret or PII — a hard invariant.
            logger?.warn({ ...line, err: 'errors' in result ? result.errors : undefined }, 'graphql operation failed');
          } else {
            logger?.info(line, 'graphql operation');
          }
        },
      };
    },
  };
}
