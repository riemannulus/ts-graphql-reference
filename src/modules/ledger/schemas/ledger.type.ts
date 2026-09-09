import { builder } from '../../../graphql/builder.js';
import { parseSwapRateKind, SWAP_RATE_KINDS } from '../ledger.core.js';
import { EVENT_PAGE_SIZE } from '../ledger.read.repo.js';
import {
  ACTOR_KINDS,
  CLOSE_REASONS,
  CURRENCIES,
  EVENT_OPS,
  HOLDER_KINDS,
  LOT_SOURCES,
  parseActorKind,
  parseCloseReason,
  parseCurrency,
  parseEventOp,
  parseHolderKind,
  parseLotSource,
  parseReferenceKindValue,
  parseReferenceState,
  REFERENCE_KINDS,
  REFERENCE_STATES,
} from '../ledger.value.js';

/**
 * The ledger's GraphQL types — a read surface over the money.
 *
 * Every enum here is built from the same `const` array the kernel decides with
 * and the migration constrains, so the API's value set cannot drift from either.
 * The string columns are PARSED on the way out (`parseCurrency`, …) rather than
 * cast: a value the database should not contain fails as a masked error instead
 * of silently appearing in a client's response.
 */
export function registerLedgerTypes(): void {
  const CurrencyEnum = builder.enumType('LedgerCurrency', {
    values: CURRENCIES,
    description:
      'The kinds of value the ledger holds. PAID_POINT and FREE_POINT are held ' +
      'as dated lots; INCOME and MILEAGE are running balances.',
  });

  const HolderKindEnum = builder.enumType('LedgerHolderKind', {
    values: HOLDER_KINDS,
    description:
      'What an account belongs to: a person (USER, RECEIVABLE) or a money flow ' +
      '(ESCROW, PAYABLE).',
  });

  const ReferenceKindEnum = builder.enumType('LedgerReferenceKind', {
    values: REFERENCE_KINDS,
    description: 'What kind of money flow a reference is.',
  });

  const ReferenceStateEnum = builder.enumType('LedgerReferenceState', {
    values: REFERENCE_STATES,
    description: 'OPEN (nothing moved) → FUNDED (money moved) → CLOSED (finished).',
  });

  const CloseReasonEnum = builder.enumType('LedgerCloseReason', {
    values: CLOSE_REASONS,
    description: 'How a flow ended. Null while it is still open.',
  });

  const LotSourceEnum = builder.enumType('LedgerLotSource', {
    values: LOT_SOURCES,
    description: "Where a lot's value came from. Decides whether it can be paid out.",
  });

  const EventOpEnum = builder.enumType('LedgerEventOp', {
    values: EVENT_OPS,
    description:
      'MINT and BURN cross the supply boundary; MOVE conserves value; a SWAP is ' +
      'recorded as its two halves, SWAP_BURN and SWAP_MINT.',
  });

  const ActorKindEnum = builder.enumType('LedgerActorKind', {
    values: ACTOR_KINDS,
    description: 'Who caused a movement.',
  });

  const SwapRateKindEnum = builder.enumType('LedgerSwapRateKind', {
    values: SWAP_RATE_KINDS,
    description:
      'The edges of the currency graph. An exchange that is not one of these ' +
      'has no rate and cannot be recorded.',
  });

  builder.prismaObject('LedgerReference', {
    description:
      'One money flow, from before anything moved. Its id is what a person ' +
      'quotes to support and what external systems correlate on. The ledger is ' +
      'READ-ONLY over GraphQL by design: value moves only through the domain ' +
      'use-case that is entitled to move it (paying for an order, redeeming a ' +
      'gift), never through a general-purpose mutation.',
    fields: (t) => ({
      id: t.exposeID('id'),
      kind: t.field({
        type: ReferenceKindEnum,
        resolve: (reference) => parseReferenceKindValue(reference.kind),
      }),
      state: t.field({
        type: ReferenceStateEnum,
        resolve: (reference) => parseReferenceState(reference.state),
      }),
      closeReason: t.field({
        type: CloseReasonEnum,
        nullable: true,
        description: 'Null until the flow closes.',
        resolve: (reference) =>
          reference.closeReason === null ? null : parseCloseReason(reference.closeReason),
      }),
      parent: t.relation('parent', { nullable: true }),
      children: t.relation('children'),
      initiator: t.relation('initiator', { nullable: true }),
      openedAt: t.string({ resolve: (reference) => reference.openedAt.toISOString() }),
      closedAt: t.string({
        nullable: true,
        resolve: (reference) => reference.closedAt?.toISOString() ?? null,
      }),
      expiresAt: t.string({
        nullable: true,
        description: 'When an untouched flow is voided by the sweep.',
        resolve: (reference) => reference.expiresAt?.toISOString() ?? null,
      }),
      // Capped like the top-level read, and for the same reason: one posting can
      // carry hundreds of events. Walk past the cap with `ledgerReferenceEvents`,
      // which takes a cursor.
      events: t.relation('events', {
        description: `The first ${EVENT_PAGE_SIZE} movements, oldest first.`,
        query: { orderBy: { seq: 'asc' }, take: EVENT_PAGE_SIZE },
      }),
      holders: t.relation('holders'),
    }),
  });

  builder.prismaObject('LedgerHolder', {
    description: 'An account that can hold value.',
    fields: (t) => ({
      key: t.exposeID('key', { description: 'The account name, e.g. `USER:7`.' }),
      kind: t.field({ type: HolderKindEnum, resolve: (holder) => parseHolderKind(holder.kind) }),
      user: t.relation('user', { nullable: true }),
      reference: t.relation('reference', { nullable: true }),
      balances: t.relation('balances'),
    }),
  });

  builder.prismaObject('LedgerBalance', {
    description: 'What one account holds of one currency. Derived from the event log.',
    fields: (t) => ({
      currency: t.field({
        type: CurrencyEnum,
        resolve: (balance) => parseCurrency(balance.currency),
      }),
      amount: t.exposeInt('amount'),
      holder: t.relation('holder'),
    }),
  });

  builder.prismaObject('LedgerLot', {
    description:
      'A minted parcel of a lotted currency. Its identity survives movement, so ' +
      'a refund returns the same deadlines the payment created.',
    fields: (t) => ({
      id: t.exposeID('id'),
      currency: t.field({ type: CurrencyEnum, resolve: (lot) => parseCurrency(lot.currency) }),
      source: t.field({ type: LotSourceEnum, resolve: (lot) => parseLotSource(lot.source) }),
      originalAmount: t.exposeInt('originalAmount'),
      owner: t.relation('owner'),
      mintReference: t.relation('mintReference'),
      mintedAt: t.string({ resolve: (lot) => lot.mintedAt.toISOString() }),
      validUntil: t.string({
        description: 'After this instant the remainder is swept.',
        resolve: (lot) => lot.validUntil.toISOString(),
      }),
      cancellableUntil: t.string({
        nullable: true,
        description:
          'Until this instant an untouched lot can go back to what funded it. ' +
          'Null when the funding source does not allow it.',
        resolve: (lot) => lot.cancellableUntil?.toISOString() ?? null,
      }),
    }),
  });

  builder.prismaObject('LedgerLotBalance', {
    description: "Where a lot's remainder currently sits.",
    fields: (t) => ({
      amount: t.exposeInt('amount'),
      lot: t.relation('lot'),
      holder: t.relation('holder'),
    }),
  });

  builder.prismaObject('LedgerSwap', {
    description:
      'One currency exchange: the burn side destroyed value, the mint side ' +
      'created it, and the difference is the fee that left for the cash books.',
    fields: (t) => ({
      id: t.exposeID('id'),
      rateKind: t.field({
        type: SwapRateKindEnum,
        resolve: (swap) => parseSwapRateKind(swap.rateKind),
      }),
      burnCurrency: t.field({
        type: CurrencyEnum,
        resolve: (swap) => parseCurrency(swap.burnCurrency),
      }),
      mintCurrency: t.field({
        type: CurrencyEnum,
        resolve: (swap) => parseCurrency(swap.mintCurrency),
      }),
      feePermille: t.exposeInt('feePermille'),
      feeKrw: t.exposeInt('feeKrw'),
      reference: t.relation('reference'),
    }),
  });

  builder.prismaObject('LedgerEvent', {
    description:
      'One movement. Append-only: the amount is always positive and the ' +
      'direction is carried by the op plus the holders, never by a sign.',
    fields: (t) => ({
      seq: t.exposeID('seq', { description: 'Monotonic position in the log.' }),
      op: t.field({ type: EventOpEnum, resolve: (event) => parseEventOp(event.op) }),
      currency: t.field({
        type: CurrencyEnum,
        resolve: (event) => parseCurrency(event.currency),
      }),
      amount: t.exposeInt('amount'),
      reason: t.exposeString('reason'),
      fromHolderKey: t.exposeString('fromHolderKey', { nullable: true }),
      toHolderKey: t.exposeString('toHolderKey', { nullable: true }),
      feeKrw: t.exposeInt('feeKrw', {
        description: 'Cash that left the ledger with this movement.',
      }),
      externalRef: t.exposeString('externalRef', { nullable: true }),
      actorKind: t.field({
        type: ActorKindEnum,
        resolve: (event) => parseActorKind(event.actorKind),
      }),
      createdAt: t.string({ resolve: (event) => event.createdAt.toISOString() }),
      lot: t.relation('lot', { nullable: true }),
      swap: t.relation('swap', { nullable: true }),
      reference: t.relation('reference'),
    }),
  });
}
