import { createClient } from 'graphql-ws';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

/**
 * The TRANSPORT proof — the one test in the suite that binds a real port and
 * talks to it over a real socket.
 *
 * Every other subscription test can (and does) work against the pieces: the rate
 * policy is property-tested pure, the topic catalog is type-checked, the context
 * factory is unit-tested. None of that answers the question this file exists for
 * — does an event published by a service actually come out the other end of a
 * live SSE stream and a live WebSocket, for the right user and nobody else?
 * That question cannot be answered by `app.inject`, which buffers a response and
 * has no upgrade path, so this file pays for `app.listen({ port: 0 })`.
 *
 * Three laws are pinned here, in the order they matter:
 *
 *  1. an authenticated subscriber RECEIVES events pushed after it subscribed —
 *     over SSE and over graphql-ws, and through BOTH delivery rungs (a rung-0
 *     `spend`, published straight to the bus, and a rung-1 `charge`, which only
 *     reaches the bus once the outbox drains);
 *  2. an anonymous subscriber is REFUSED with `UNAUTHENTICATED` rather than
 *     handed a stream;
 *  3. a subscriber sees its OWN user's events and no one else's.
 *
 * Every publish happens AFTER the stream is open. That is deliberate: an event
 * that was already on the bus when the client connected would prove replay, not
 * push, and push is the property the whole subscription stack claims.
 *
 * PGlite is single-connection, so nothing here is concurrent by design: each
 * phase (seed → subscribe → publish → assert) is awaited to completion before
 * the next begins, and the only overlap the file tolerates is the subscription
 * resolver's re-fetch racing the outbox drainer's bookkeeping transaction —
 * which PGlite serializes rather than deadlocking, because neither awaits the
 * other.
 */

const prisma = await makeTestPrisma();
// The real bus (in-process, no Redis) and the real outbox: this file is here to
// exercise the wiring, so nothing about the event path is faked. The clock stays
// `systemClock` — a `fixedClock` would freeze `planEmit` and the throttle on
// `pointBalanceChanged` (minIntervalMs: 1000) would never release a suppressed
// event, hanging the stream.
const { app, services, outbox } = buildApp({ prisma, logger: false });

const SUBSCRIPTION = 'subscription { pointBalanceChanged { totalAmount user { email } } }';

/** How long an event may take to travel service → bus → transport → client. */
const DELIVERY_TIMEOUT_MS = 5_000;
/**
 * How long we watch a stream that must stay SILENT. Generous on purpose: a
 * too-short window would let a cross-user leak pass as "nothing arrived", and a
 * false green on the isolation law is the worst outcome this file can produce.
 */
const SILENCE_WINDOW_MS = 750;
/** Bounded per-test budget — a stuck socket must fail the test, not hang the suite. */
const TEST_TIMEOUT_MS = 30_000;

let httpEndpoint = '';
let wsEndpoint = '';

beforeAll(async () => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('expected a TCP address from a port-0 listen');
  }
  httpEndpoint = `http://127.0.0.1:${address.port}/graphql`;
  wsEndpoint = `ws://127.0.0.1:${address.port}/graphql/ws`;
});

beforeEach(() => resetDb(prisma));

afterAll(async () => {
  await app.close();
  await prisma.$disconnect(); // injected clients stay the injector's to manage
});

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** The shape `pointBalanceChanged` delivers, on either transport. */
interface SubscriptionPayload {
  data?: { pointBalanceChanged?: { totalAmount: number; user: { email: string } } } | null;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

interface Subscriber {
  readonly userId: number;
  readonly email: string;
  readonly token: string;
}

/**
 * A user with a live session row and a consistent point ledger, written
 * DIRECTLY with prisma rather than through the services.
 *
 * Two reasons, both about keeping the test honest. The session is inserted
 * instead of minted through OAuth because this file is not testing how a
 * credential is obtained — only that presenting one works. And the ledger is
 * seeded rather than charged because `charge` publishes an event: setting up
 * through it would put a `pointBalanceChanged` on the bus before the assertions
 * begin, and every "the first event was X" claim below would be racing it.
 */
async function seedSubscriber(email: string, paidAmount: number): Promise<Subscriber> {
  const user = await prisma.user.create({ data: { email } });
  const token = `seeded-session-${email}`;
  await prisma.session.create({
    data: {
      accessToken: token,
      userId: user.id,
      // An hour out: far enough that `resolvePrincipal`'s expiry comparison is
      // never the thing under test here.
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    },
  });
  await prisma.pointBalance.create({
    data: { userId: user.id, paidAmount, freeAmount: 0, totalAmount: paidAmount },
  });
  // The balance is denormalized from the charge ledger, so a seeded balance with
  // no matching USABLE charge would make `spend` fail its own consistency guard.
  await prisma.pointCharge.create({
    data: {
      userId: user.id,
      state: 'USABLE',
      paidAmount,
      freeAmount: 0,
      unspentPaidAmount: paidAmount,
      unspentFreeAmount: 0,
    },
  });
  return { userId: user.id, email, token };
}

interface SseStream {
  /** The next delivered payload, or `null` if none arrives inside `timeoutMs`. */
  next(timeoutMs: number): Promise<SubscriptionPayload | null>;
  close(): Promise<void>;
}

/**
 * Opens a subscription over Server-Sent Events — the transport Yoga serves on
 * the SAME `/graphql` route as queries, with no extra app code, which is exactly
 * why it is worth proving: a stray `addContentTypeParser` or a buffering hook
 * would silently turn the stream into a request that never completes.
 *
 * Frames are pumped into a queue by a background reader rather than read
 * on demand, so an event that lands while no one is awaiting `next()` is
 * remembered instead of lost — the difference between testing delivery and
 * testing our own polling luck.
 */
async function openSse(headers: Record<string, string>): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(httpEndpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
    body: JSON.stringify({ query: SUBSCRIPTION }),
    signal: controller.signal,
  });
  // Reaching this line at all is half the proof: if Fastify buffered the
  // response, the headers would not arrive until a stream that never ends did.
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const body = response.body;
  if (body === null) throw new Error('the SSE response carried no body');

  const reader = body.getReader();
  const decoder = new TextDecoder();
  const delivered: SubscriptionPayload[] = [];
  let buffer = '';

  const pump = (async () => {
    try {
      for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a stream is sequential by definition
        const chunk = await reader.read();
        if (chunk.value !== undefined) buffer += decoder.decode(chunk.value, { stream: true });
        // SSE frames are separated by a blank line; `data:` with nothing after
        // it is the `complete` frame and carries no payload.
        for (
          let boundary = buffer.indexOf('\n\n');
          boundary >= 0;
          boundary = buffer.indexOf('\n\n')
        ) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .find((line) => line.startsWith('data:'))
            ?.slice('data:'.length)
            .trim();
          if (data !== undefined && data.length > 0) {
            delivered.push(JSON.parse(data) as SubscriptionPayload);
          }
        }
        if (chunk.done) break;
      }
    } catch {
      // `close()` aborts the request; that rejection is the only way out of a
      // subscription stream, and it is not a failure.
    }
  })();

  return {
    async next(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const head = delivered.shift();
        if (head !== undefined) return head;
        if (Date.now() >= deadline) return null;
        // eslint-disable-next-line no-await-in-loop -- polling the pump's queue until the deadline
        await sleep(10);
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
      await pump;
    },
  };
}

/** What a graphql-ws subscription attempt ended up doing. */
type WsOutcome =
  | { readonly kind: 'next'; readonly payload: SubscriptionPayload }
  | { readonly kind: 'error'; readonly detail: string }
  | { readonly kind: 'complete' }
  | { readonly kind: 'timeout' };

/**
 * `graphql-ws`'s `error` callback hands back either an array of GraphQLErrors
 * (the server refused the operation) or a transport-level event (the socket
 * itself failed). Both are flattened to a string so a failing assertion prints
 * something a human can act on instead of `{}`.
 */
function describeWsError(error: unknown): string {
  if (Array.isArray(error)) return `graphql errors ${JSON.stringify(error)}`;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === 'object' && error !== null) {
    const event = error as { type?: unknown; code?: unknown; reason?: unknown };
    return `socket event type=${String(event.type)} code=${String(event.code)} reason=${String(event.reason)}`;
  }
  return String(error);
}

/**
 * Subscribes over graphql-ws and returns the first thing that happens, after
 * running `publish()` once the socket has settled.
 *
 * The credential travels in `connectionParams`, which is the LEGACY channel and
 * deliberately the one exercised here: a WS upgrade carries cookies like any
 * other request (that channel is proven by the SSE cases), so
 * `connectionParams` is the path with no HTTP-side coverage anywhere else.
 */
async function runWsSubscription(
  connectionParams: Record<string, unknown> | undefined,
  publish: () => Promise<void>,
): Promise<WsOutcome> {
  const client = createClient({
    url: wsEndpoint,
    webSocketImpl: globalThis.WebSocket,
    // No reconnect: a refused or broken connection must surface as a failed
    // assertion, not as a retry loop that eats the test's timeout.
    retryAttempts: 0,
    ...(connectionParams === undefined ? {} : { connectionParams }),
  });
  try {
    // Whichever of next / error / complete / the deadline lands first wins; the
    // later ones are no-ops, because a settled promise ignores them.
    let settle!: (outcome: WsOutcome) => void;
    const outcome = new Promise<WsOutcome>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => settle({ kind: 'timeout' }), DELIVERY_TIMEOUT_MS);
    client.subscribe(
      { query: SUBSCRIPTION },
      {
        next: (value) => settle({ kind: 'next', payload: value as SubscriptionPayload }),
        error: (error) => settle({ kind: 'error', detail: describeWsError(error) }),
        complete: () => settle({ kind: 'complete' }),
      },
    );
    // The client is lazy: the socket opens, the connection is acknowledged and
    // the `subscribe` message is processed only after the call above. Publishing
    // before that lands would test replay, which this transport does not do.
    await sleep(400);
    await publish();
    const result = await outcome;
    clearTimeout(timer);
    return result;
  } finally {
    await client.dispose();
  }
}

describe('subscriptions over a real socket', () => {
  it(
    'SSE pushes a rung-0 event to an authenticated subscriber',
    async () => {
      const alice = await seedSubscriber('alice@sse.test', 100);
      const stream = await openSse({ cookie: `sid=${alice.token}` });
      try {
        // `spend` is rung 0: it publishes to the bus itself, right after its
        // transaction commits. Nothing but the transport stands between the
        // service call and the client.
        await services.point.spend(alice.userId, { amount: 40, reason: 'e2e-sse' });

        const event = await stream.next(DELIVERY_TIMEOUT_MS);
        // The payload carries ids only, so the figure below can only have come
        // from the resolver's re-fetch of CURRENT state — which is the whole
        // reason a duplicate or reordered event is harmless.
        expect(event?.data?.pointBalanceChanged).toEqual({
          totalAmount: 60,
          user: { email: alice.email },
        });
      } finally {
        await stream.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'SSE pushes a rung-1 (outbox) event once the drainer runs',
    async () => {
      const alice = await seedSubscriber('alice@outbox.test', 100);
      const stream = await openSse({ cookie: `sid=${alice.token}` });
      try {
        // `charge` is the module's one rung-1 path: the event is written in the
        // charge's own transaction and reaches the bus only when the outbox
        // drains. This test is the end-to-end half of that rung — the repo can
        // prove the row is enqueued without ever proving a live subscriber sees
        // it, and "the money arrived but the client never heard" is exactly the
        // failure the rung exists to prevent.
        await services.point.charge(alice.userId, { paidAmount: 25, freeAmount: 0 });
        // `notify()` already kicked a drain in the background; draining
        // explicitly makes delivery a fact rather than a race. Both drains claim
        // with FOR UPDATE SKIP LOCKED, so at most one publishes the row.
        await outbox.drain();

        const event = await stream.next(DELIVERY_TIMEOUT_MS);
        expect(event?.data?.pointBalanceChanged).toEqual({
          totalAmount: 125,
          user: { email: alice.email },
        });
      } finally {
        await stream.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'graphql-ws pushes the same event over a WebSocket',
    async () => {
      const alice = await seedSubscriber('alice@ws.test', 100);

      const outcome = await runWsSubscription({ accessToken: alice.token }, async () => {
        await services.point.spend(alice.userId, { amount: 40, reason: 'e2e-ws' });
      });

      // Both transports run the SAME envelop pipeline and the SAME context
      // factory (`yoga.getEnveloped` in app.ts), so asserting the identical
      // payload as the SSE case is the point: the two paths must not drift.
      //
      // If this fails with a bare socket error instead of a GraphQL one, the
      // upgrade never happened and no amount of subscription logic is involved:
      // `websocket: true` is honored only for routes declared AFTER
      // @fastify/websocket has finished loading, so registering the plugin
      // without awaiting it — and without deferring the route into `app.after`
      // — leaves this handler wired up as an ordinary HTTP handler that the
      // adapter cannot drive. Nothing else in the suite can see that: it is
      // invisible to typecheck, to lint, and to every `app.inject` test, which
      // is precisely why this file binds a real port.
      expect(outcome).toEqual({
        kind: 'next',
        payload: {
          data: { pointBalanceChanged: { totalAmount: 60, user: { email: alice.email } } },
        },
      });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'refuses an anonymous subscriber with UNAUTHENTICATED instead of a stream',
    async () => {
      await seedSubscriber('alice@anon.test', 100);
      // No cookie, no bearer, no connectionParams. `requirePrincipal` throws
      // inside `subscribe`, so the refusal is delivered ON the event stream and
      // then completed — the client learns why rather than watching a socket
      // that never speaks.
      const stream = await openSse({});
      try {
        const refusal = await stream.next(DELIVERY_TIMEOUT_MS);
        expect(refusal?.errors?.[0]?.extensions?.code).toBe('UNAUTHENTICATED');
        expect(refusal?.data?.pointBalanceChanged).toBeUndefined();
      } finally {
        await stream.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'delivers a user only its OWN events',
    async () => {
      // The most security-relevant assertion in the suite. Two things could
      // break it and both are one-character edits: subscribing on a key that is
      // not the principal's id (the topic key IS the filter), or re-fetching on
      // a `where` built from the payload instead of the principal. The first
      // would put B's event on A's stream; the second would render B's row on
      // it. The two assertions below catch them separately.
      const alice = await seedSubscriber('alice@isolation.test', 100);
      const bob = await seedSubscriber('bob@isolation.test', 100);

      const stream = await openSse({ cookie: `sid=${alice.token}` });
      try {
        await services.point.spend(bob.userId, { amount: 10, reason: 'e2e-other-user' });
        // A's stream must stay SILENT while another user's balance moves. The
        // window is checked BEFORE A's own spend on purpose: once A has spent,
        // a leaked event would re-fetch A's already-updated row and become
        // indistinguishable from a correct one.
        expect(await stream.next(SILENCE_WINDOW_MS)).toBeNull();

        await services.point.spend(alice.userId, { amount: 25, reason: 'e2e-own' });
        const event = await stream.next(DELIVERY_TIMEOUT_MS);
        expect(event?.data?.pointBalanceChanged).toEqual({
          totalAmount: 75,
          user: { email: alice.email },
        });
      } finally {
        await stream.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
