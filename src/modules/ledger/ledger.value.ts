/**
 * Ledger vocabulary — the value sets and the two parsed identities the whole
 * module speaks: a **holder key** and a **reference id**.
 *
 * "Parse, don't validate" (CONVENTIONS §4): a string becomes a `Holder` or a
 * `ReferenceId` only by going through a function here, so every layer above
 * works with values that are already known-good, and a database string re-enters
 * the domain through the same door it left by. Pure — no I/O, no clock, no
 * Prisma; the `const` arrays below are the single source of truth for the value
 * sets the migration mirrors as CHECK constraints (kept honest by
 * src/tests/integrations/schema-constraints.test.ts).
 *
 * The holder key is the interesting one. It is a pure FUNCTION of the holder
 * (`USER:7`, `ESCROW:OR-7K3M9QX2W4`), not a surrogate id, which is what lets the
 * pure core name an account that may not have a row yet — the plan says "credit
 * `ESCROW:OR-…`" and the repo creates the holder if this is its first movement.
 * A surrogate key would force a database round-trip into the middle of a
 * decision.
 */

/** The four currencies the ledger knows. */
export const CURRENCIES = ['PAID_POINT', 'FREE_POINT', 'INCOME', 'MILEAGE'] as const;
export type Currency = (typeof CURRENCIES)[number];

/**
 * The currencies whose balance is a set of named parcels rather than one
 * number. A lot carries where the value came from and when it dies, which is
 * what makes points non-fungible in the ways that matter (refundability,
 * expiry, whether a payout may touch them).
 */
export const LOTTED_CURRENCIES = ['PAID_POINT', 'FREE_POINT'] as const;
export type LottedCurrency = (typeof LOTTED_CURRENCIES)[number];
/** The currencies that are a single running balance. */
export type ScalarCurrency = Exclude<Currency, LottedCurrency>;

export function isLottedCurrency(currency: Currency): currency is LottedCurrency {
  return (LOTTED_CURRENCIES as readonly Currency[]).includes(currency);
}

/** Where a lot's value came from. A redeem policy may exclude sources. */
export const LOT_SOURCES = [
  'PG',
  'IAP',
  'GIFT_CARD',
  'INCOME_SWAP',
  'ADMIN',
  'EVENT',
  'OPENING',
] as const;
export type LotSource = (typeof LOT_SOURCES)[number];

/**
 * The four kinds of account.
 *
 * - `USER` — a person's wallet. Value enters and leaves the ledger here.
 * - `ESCROW` — an order's stake, held until it settles or reverses. Owned by a
 *   reference, not a person: the money is committed but not yet anyone's.
 * - `PAYABLE` — a withdrawal between "requested" and "the bank took it". The
 *   state that has no honest home in a single-balance design, which is why a
 *   failed transfer there is a plain move back rather than a compensating entry.
 * - `RECEIVABLE` — what a clawback could not recover. An operational loss as a
 *   positive number in a named place instead of an overdrawn wallet.
 */
export const HOLDER_KINDS = ['USER', 'ESCROW', 'PAYABLE', 'RECEIVABLE'] as const;
export type HolderKind = (typeof HOLDER_KINDS)[number];

/** An account that can hold value. Anchored to a person or to a money flow. */
export type Holder =
  | { readonly kind: 'USER'; readonly userId: number }
  | { readonly kind: 'RECEIVABLE'; readonly userId: number }
  | { readonly kind: 'ESCROW'; readonly referenceId: string }
  | { readonly kind: 'PAYABLE'; readonly referenceId: string };

export const userHolder = (userId: number): Holder => ({ kind: 'USER', userId });
export const receivableHolder = (userId: number): Holder => ({ kind: 'RECEIVABLE', userId });
export const escrowHolder = (referenceId: string): Holder => ({ kind: 'ESCROW', referenceId });
export const payableHolder = (referenceId: string): Holder => ({ kind: 'PAYABLE', referenceId });

/** True when the holder is anchored to a person rather than to a money flow. */
export function isPersonalHolder(
  holder: Holder,
): holder is Extract<Holder, { userId: number }> {
  return holder.kind === 'USER' || holder.kind === 'RECEIVABLE';
}

/**
 * The holder's name — total, injective, and computable without touching the
 * database. `USER:7` / `ESCROW:OR-7K3M9QX2W4`. Reference ids never contain a
 * colon (see `mintReferenceId`), so the first colon always splits kind from
 * anchor and `parseHolderKey` is its exact inverse (property-tested).
 */
export function holderKey(holder: Holder): string {
  return isPersonalHolder(holder)
    ? `${holder.kind}:${holder.userId}`
    : `${holder.kind}:${holder.referenceId}`;
}

/** A stored holder key was not one this code can produce. Corruption, not input. */
export class UnknownHolderKeyError extends Error {
  constructor(readonly value: string) {
    super(`Unknown ledger holder key read from the database: ${JSON.stringify(value)}`);
    this.name = 'UnknownHolderKeyError';
  }
}

/** Parses a stored holder key back into a `Holder`. The inverse of `holderKey`. */
export function parseHolderKey(key: string): Holder {
  const separator = key.indexOf(':');
  if (separator < 0) throw new UnknownHolderKeyError(key);
  const kind = key.slice(0, separator);
  const anchor = key.slice(separator + 1);
  if (anchor.length === 0) throw new UnknownHolderKeyError(key);
  if (kind === 'USER' || kind === 'RECEIVABLE') {
    // A user anchor is a positive integer; anything else is a corrupt row, not
    // a NaN to propagate.
    if (!/^[1-9]\d*$/.test(anchor)) throw new UnknownHolderKeyError(key);
    return { kind, userId: Number(anchor) };
  }
  if (kind === 'ESCROW' || kind === 'PAYABLE') return { kind, referenceId: anchor };
  throw new UnknownHolderKeyError(key);
}

/**
 * The kinds of money flow a reference can be.
 *
 * Six shapes cover every movement the ledger supports, and a production system
 * subdivides rather than extends them: crepe's thirteen (top-up, direct
 * payment, commission, extra charge, donation, membership, gift card, two
 * withdrawals, conversion, in-app purchase, store purchase, refund request) are
 * all one of these with a different policy attached.
 */
export const REFERENCE_KINDS = [
  /** Value enters the ledger for a person (a top-up, an in-app purchase). */
  'CHARGE',
  /** Value is staked into escrow, then settles to a seller, reverses, or splits. */
  'ORDER',
  /** Value leaves for a bank account, via PAYABLE. */
  'PAYOUT',
  /** Value crosses a currency boundary for the same person. */
  'CONVERSION',
  /** Value is staked by one person and redeemed by another. */
  'GIFT',
  /** An operator moves value by hand, with a reason. */
  'ADJUST',
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

/**
 * OPEN — declared, nothing has moved. FUNDED — money moved under it. CLOSED —
 * finished, and its holders are empty (law L3).
 */
export const REFERENCE_STATES = ['OPEN', 'FUNDED', 'CLOSED'] as const;
export type ReferenceState = (typeof REFERENCE_STATES)[number];

/**
 * Why a reference closed. Declared by the caller and checked against the
 * ledger, because a partial refund settles across several postings and no
 * single one of them can infer the whole flow's outcome.
 */
export const CLOSE_REASONS = [
  /** The value reached its destination. */
  'SETTLED',
  /** All of it went back where it came from. */
  'REVERSED',
  /** Some settled, some reversed. */
  'SPLIT',
  /** Nothing ever moved (an abandoned checkout, an expired intent). */
  'VOID',
  /**
   * The value ceased to exist where it sat, rather than going anywhere — a lot
   * swept past its deadline. Its own reason because "settled" would claim the
   * money reached someone, which is exactly what did not happen.
   */
  'EXPIRED',
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/**
 * The op recorded on an event row. A swap is stored as its two halves, so the
 * log can be folded per currency without knowing what a swap is.
 */
export const EVENT_OPS = ['MINT', 'BURN', 'MOVE', 'SWAP_BURN', 'SWAP_MINT'] as const;
export type EventOp = (typeof EVENT_OPS)[number];

/** Who caused a movement — stamped on every event for the audit trail. */
export const ACTOR_KINDS = ['USER', 'STAFF', 'SYSTEM', 'WEBHOOK'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];
export interface Actor {
  readonly kind: ActorKind;
  /** The acting principal, when there is one (a user id, a staff id). */
  readonly id: string | null;
}

/** The two-letter prefix each reference kind wears, so an id names its flow. */
const REFERENCE_PREFIXES = {
  CHARGE: 'CH',
  ORDER: 'OR',
  PAYOUT: 'PO',
  CONVERSION: 'CV',
  GIFT: 'GF',
  ADJUST: 'AD',
} as const satisfies Record<ReferenceKind, string>;

const PREFIX_TO_KIND = new Map<string, ReferenceKind>(
  REFERENCE_KINDS.map((kind) => [REFERENCE_PREFIXES[kind], kind]),
);

/**
 * Crockford base32 — digits and uppercase letters with `I`, `L`, `O` and `U`
 * removed. A reference id gets read aloud to support and typed back in, so the
 * alphabet excludes the characters people confuse (and `U`, which Crockford
 * drops to avoid accidental profanity).
 */
export const REFERENCE_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Suffix length. 32^10 ≈ 1.1e15 — collision-free in practice at any sane rate. */
export const REFERENCE_ID_SUFFIX_LENGTH = 10;

const SUFFIX_PATTERN = new RegExp(
  `^[${REFERENCE_ID_ALPHABET}]{${REFERENCE_ID_SUFFIX_LENGTH}}$`,
);

export class InvalidReferenceSuffixError extends Error {
  constructor(readonly value: string) {
    super(
      `Reference id suffix must be ${REFERENCE_ID_SUFFIX_LENGTH} Crockford base32 ` +
        `characters, got ${JSON.stringify(value)}`,
    );
    this.name = 'InvalidReferenceSuffixError';
  }
}

/**
 * Builds a reference id from its kind and a random suffix. Pure: the randomness
 * is an effect, so the SUFFIX arrives as data (the service mints it from an
 * injected source, exactly as `now` arrives from the injected clock).
 *
 * The id is not a sequence because it is handed to third parties — a PSP, a
 * bank, a store — before any row exists, and it is what a person quotes to
 * support. A leading two letters make the kind readable at a glance and make
 * `parseReferenceKind` a total inverse.
 */
export function mintReferenceId(kind: ReferenceKind, suffix: string): string {
  if (!SUFFIX_PATTERN.test(suffix)) throw new InvalidReferenceSuffixError(suffix);
  return `${REFERENCE_PREFIXES[kind]}-${suffix}`;
}

/** A stored reference id does not name a kind this code knows. Corruption. */
export class UnknownReferenceIdError extends Error {
  constructor(readonly value: string) {
    super(`Unknown ledger reference id read from the database: ${JSON.stringify(value)}`);
    this.name = 'UnknownReferenceIdError';
  }
}

/** Reads a reference id's kind back out of it. The inverse of `mintReferenceId`. */
export function parseReferenceKind(id: string): ReferenceKind {
  const kind = PREFIX_TO_KIND.get(id.slice(0, 2));
  if (!kind || id[2] !== '-' || !SUFFIX_PATTERN.test(id.slice(3))) {
    throw new UnknownReferenceIdError(id);
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Reading values back out of the database
// ---------------------------------------------------------------------------

/**
 * A stored string is not a member of the set this code knows. The CHECK
 * constraints make it unreachable; if it ever fires, that is corruption — a
 * plain (masked) Error, and never silently coerced into a default.
 */
export class UnknownLedgerValueError extends Error {
  constructor(
    readonly what: string,
    readonly value: string,
  ) {
    super(`Unknown ledger ${what} read from the database: ${JSON.stringify(value)}`);
    this.name = 'UnknownLedgerValueError';
  }
}

/**
 * Parse, don't validate — the one door a database string walks through to
 * become a domain value. One generic function rather than six near-identical
 * ones: the SETS are the interesting part and they are declared above, so
 * repeating the narrowing per set would be six chances to write `as` instead.
 */
export function parseMember<T extends string>(
  set: readonly T[],
  value: string,
  what: string,
): T {
  if (!(set as readonly string[]).includes(value)) throw new UnknownLedgerValueError(what, value);
  return value as T;
}

export const parseCurrency = (value: string): Currency =>
  parseMember(CURRENCIES, value, 'currency');
export const parseLottedCurrency = (value: string): LottedCurrency =>
  parseMember(LOTTED_CURRENCIES, value, 'lotted currency');
export const parseLotSource = (value: string): LotSource =>
  parseMember(LOT_SOURCES, value, 'lot source');
export const parseHolderKind = (value: string): HolderKind =>
  parseMember(HOLDER_KINDS, value, 'holder kind');
export const parseReferenceState = (value: string): ReferenceState =>
  parseMember(REFERENCE_STATES, value, 'reference state');
export const parseReferenceKindValue = (value: string): ReferenceKind =>
  parseMember(REFERENCE_KINDS, value, 'reference kind');
export const parseCloseReason = (value: string): CloseReason =>
  parseMember(CLOSE_REASONS, value, 'close reason');
export const parseEventOp = (value: string): EventOp => parseMember(EVENT_OPS, value, 'event op');
export const parseActorKind = (value: string): ActorKind =>
  parseMember(ACTOR_KINDS, value, 'actor kind');
