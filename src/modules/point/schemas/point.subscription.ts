import { builder } from '../../../graphql/builder.js';
import { requirePrincipal } from '../../../graphql/context.js';

/**
 * The point module's SUBSCRIPTION delivery — the peer of `point.query.ts` and
 * `point.mutation.ts`, and the reference's worked example of a realtime field.
 *
 * Read it as four rules applied at once:
 *
 * 1. **The stream comes from `ctx.events`**, whose type has no `publish`. A
 *    schema file cannot emit an event even by accident.
 * 2. **The topic key IS the filter.** Subscribing with the principal's own id
 *    means this connection only ever receives its own user's events — no
 *    `filter` operator, so other instances never fan out events this subscriber
 *    would discard.
 * 3. **The rate is DECLARED, not assembled.** `minIntervalMs` is config the bus
 *    honors; the operator itself lives in `events/operators.ts` and the policy
 *    it runs on is the pure, property-tested `planEmit`.
 * 4. **The re-fetch is the authorization boundary.** The `where` is built from
 *    `requirePrincipal(ctx)`, never from the payload — so even a service that
 *    published to the wrong key cannot show one user another user's balance. The
 *    payload's job is to say "something changed", not "show them this row".
 *
 * The payload carries an id and nothing else, which is what makes every one of
 * those rules affordable: duplicates, reordering, and coalescing under the
 * throttle are all unobservable when the resolver reads current state anyway.
 */
export function registerPointSubscriptions(): void {
  builder.subscriptionFields((t) => ({
    pointBalanceChanged: t.prismaField({
      type: 'PointBalance',
      description:
        "Streams the authenticated user's point balance whenever it changes " +
        '(charge, spend, transfer, or expiry). Rate-limited server-side.',
      subscribe: (_root, _args, ctx) =>
        ctx.events.subscribe('pointBalanceChanged', requirePrincipal(ctx).userId, {
          // One update per second is plenty for a balance readout, and it bounds
          // what a burst of spends can push at a slow mobile socket. Suppressed
          // events coalesce rather than queue.
          minIntervalMs: 1000,
        }),
      resolve: (query, _payload, _args, ctx) =>
        ctx.db.pointBalance.findUniqueOrThrow({
          ...query,
          // `userId` is the PK of PointBalance and the audience of the topic are
          // the same person, so the principal alone identifies the row and the
          // payload contributes nothing to the lookup. A topic whose subject
          // differs from its audience (crepe's DM streams) would use BOTH: the
          // id from the payload, the ownership column from the principal.
          where: { userId: requirePrincipal(ctx).userId },
        }),
    }),
  }));
}
