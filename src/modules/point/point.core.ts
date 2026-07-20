import { DomainError } from '../../errors.js';

/**
 * Point domain — the pure core.
 *
 * This module is the reference's showcase of "decide in the core, execute in
 * the shell": `planSpend` computes a complete description of what a spend must
 * write (a `SpendPlan`) without touching the database. The shell
 * (point.service.ts) reads the world, calls this function, and mechanically
 * applies the returned plan (point.repo.ts). Every business branch of the
 * point domain lives here, where property-based tests can hammer it with
 * thousands of random ledgers in milliseconds.
 *
 * The input types below are what the core *demands of the world* — narrow,
 * structural, and Prisma-free. The repo maps database rows into them; the core
 * never learns where they came from.
 */

export const POINT_CHARGE_STATES = ['USABLE', 'CONSUMED'] as const;
export type PointChargeState = (typeof POINT_CHARGE_STATES)[number];

/** A user's denormalized point balance — what the spend decision is made against. */
export interface PointSnapshot {
  paidAmount: number;
  freeAmount: number;
  totalAmount: number;
}

/** The spendable remainder of one charge. Order in a list is the spend order (FIFO). */
export interface ChargeBalance {
  id: number;
  unspentPaid: number;
  unspentFree: number;
}

/** How much of one charge a spend consumes. */
export interface SpendAllocation {
  chargeId: number;
  paid: number;
  free: number;
  /**
   * The unspent amounts this plan ASSUMED the charge still had. The shell uses
   * them as optimistic-concurrency guards: the corresponding UPDATE matches on
   * these values, so a concurrent spend that consumed the charge first makes
   * the write miss instead of double-spending.
   */
  assumed: { unspentPaid: number; unspentFree: number };
  /** True when this spend empties the charge (→ state CONSUMED). */
  depleted: boolean;
}

/**
 * The complete, not-yet-executed description of one spend: what the decision
 * phase produced and everything the execution phase needs. Pure data — nothing
 * has happened to the database when a value of this type exists.
 */
export interface SpendPlan {
  /** Paid points consumed (paid-first policy). */
  paidUsage: number;
  /** Free points consumed. */
  freeUsage: number;
  /** Per-charge consumption, in spend (FIFO) order. */
  allocations: SpendAllocation[];
  /** The balance the plan assumed — the shell's guard for the balance UPDATE. */
  assumedBalance: PointSnapshot;
  /** The balance after the spend. */
  balanceAfter: PointSnapshot;
}

export class PointAmountNotPositiveError extends DomainError {
  constructor(readonly amount: number) {
    super(`Point amount must be a positive integer, got ${amount}`, 'INVALID_POINT_AMOUNT');
  }
}

export class InsufficientPointError extends DomainError {
  constructor(
    readonly available: number,
    readonly requested: number,
  ) {
    super(`Insufficient points: have ${available}, need ${requested}`, 'INSUFFICIENT_POINT');
  }
}

/**
 * The snapshot promised more points than the charges can cover — the ledger is
 * corrupt. Deliberately NOT a DomainError: this is an internal invariant
 * violation, so the GraphQL layer masks it instead of exposing it to clients.
 */
export class PointLedgerInconsistencyError extends Error {
  constructor(snapshot: PointSnapshot, uncovered: { paid: number; free: number }) {
    super(
      `Point ledger inconsistent: snapshot ${JSON.stringify(snapshot)} not covered by charges ` +
        `(paid ${uncovered.paid}, free ${uncovered.free} unallocatable)`,
    );
    this.name = 'PointLedgerInconsistencyError';
  }
}

export function isPointChargeState(value: string): value is PointChargeState {
  return (POINT_CHARGE_STATES as readonly string[]).includes(value);
}

/**
 * An unknown charge state came out of the database. The CHECK constraint makes
 * this unreachable in practice; if it ever fires, that is corruption — a plain
 * (masked) Error, not a client-visible DomainError, and never silently coerced.
 */
export class UnknownPointChargeStateError extends Error {
  constructor(readonly value: string) {
    super(`Unknown point charge state read from the database: ${JSON.stringify(value)}`);
    this.name = 'UnknownPointChargeStateError';
  }
}

/** Parse, don't validate: DB strings become `PointChargeState` only through here. */
export function parsePointChargeState(value: string): PointChargeState {
  if (!isPointChargeState(value)) {
    throw new UnknownPointChargeStateError(value);
  }
  return value;
}

/** Total predicate: is `amount` a valid point amount (positive integer)? */
export function isValidPointAmount(amount: number): boolean {
  return Number.isInteger(amount) && amount > 0;
}

function assertValidAmount(amount: number): void {
  if (!isValidPointAmount(amount)) {
    throw new PointAmountNotPositiveError(amount);
  }
}

/** What a charge (top-up) must write: the new charge row and the balance deltas. */
export interface ChargePlan {
  paidAmount: number;
  freeAmount: number;
  totalAmount: number;
}

const isValidChargeSide = (n: number) => Number.isInteger(n) && n >= 0;

/**
 * Decides a charge (top-up). Trivial today, but the rule "at least one side
 * positive, neither negative, both integers" still lives here rather than in
 * the shell.
 */
export function planCharge(input: { paidAmount: number; freeAmount: number }): ChargePlan {
  const { paidAmount, freeAmount } = input;
  // Report the side that is actually at fault, not the (misleading) sum.
  if (!isValidChargeSide(paidAmount)) {
    throw new PointAmountNotPositiveError(paidAmount);
  }
  if (!isValidChargeSide(freeAmount)) {
    throw new PointAmountNotPositiveError(freeAmount);
  }
  if (paidAmount + freeAmount === 0) {
    throw new PointAmountNotPositiveError(0);
  }
  return { paidAmount, freeAmount, totalAmount: paidAmount + freeAmount };
}

/**
 * Decides one spend: given the balance snapshot, the USABLE charges in spend
 * order, and the requested amount, returns the complete `SpendPlan` — or
 * throws.
 *
 * Policies encoded here (each guarded by a property test):
 * 1. Paid-first: paid points are consumed before free points.
 * 2. FIFO: charges are consumed in the given order.
 * 3. A charge whose remainder hits zero is depleted (→ CONSUMED).
 * 4. Conservation: allocations sum exactly to the requested amount, split
 *    exactly into paidUsage + freeUsage — checked BEFORE anything is written
 *    (a mismatch means the ledger is corrupt, not a client error).
 *
 * Total: for every input this returns a plan or throws one of
 * `PointAmountNotPositiveError` | `InsufficientPointError` |
 * `PointLedgerInconsistencyError` — never anything else.
 */
export function planSpend(
  snapshot: PointSnapshot,
  charges: readonly ChargeBalance[],
  amount: number,
): SpendPlan {
  assertValidAmount(amount);
  if (snapshot.totalAmount < amount) {
    throw new InsufficientPointError(snapshot.totalAmount, amount);
  }

  // Policy 1 — paid-first split of the requested amount.
  const paidUsage = Math.min(amount, snapshot.paidAmount);
  const freeUsage = amount - paidUsage;

  // Policy 2/3 — FIFO allocation across charges.
  const allocations: SpendAllocation[] = [];
  let paidLeft = paidUsage;
  let freeLeft = freeUsage;
  for (const charge of charges) {
    if (paidLeft === 0 && freeLeft === 0) break;
    const paid = Math.min(paidLeft, charge.unspentPaid);
    const free = Math.min(freeLeft, charge.unspentFree);
    if (paid + free === 0) continue;
    paidLeft -= paid;
    freeLeft -= free;
    allocations.push({
      chargeId: charge.id,
      paid,
      free,
      assumed: { unspentPaid: charge.unspentPaid, unspentFree: charge.unspentFree },
      depleted: charge.unspentPaid + charge.unspentFree - paid - free === 0,
    });
  }

  // Policy 4 — conservation, verified before a single write exists.
  if (paidLeft !== 0 || freeLeft !== 0) {
    throw new PointLedgerInconsistencyError(snapshot, { paid: paidLeft, free: freeLeft });
  }

  return {
    paidUsage,
    freeUsage,
    allocations,
    assumedBalance: snapshot,
    balanceAfter: {
      paidAmount: snapshot.paidAmount - paidUsage,
      freeAmount: snapshot.freeAmount - freeUsage,
      totalAmount: snapshot.totalAmount - amount,
    },
  };
}

/** Transferring points to the same account is a no-op the client must not ask for. */
export class PointTransferToSelfError extends DomainError {
  constructor(readonly userId: number) {
    super(`Cannot transfer points to the same user (${userId})`, 'POINT_TRANSFER_TO_SELF');
  }
}

/**
 * The complete description of a transfer: the sender's spend and the receiver's
 * charge. Pure data — both halves execute together in one transaction.
 */
export interface TransferPlan {
  /** What leaves the sender (paid-first, FIFO, with the spend's guards). */
  spend: SpendPlan;
  /** What the receiver gains — the SAME paid/free split, so points keep their kind. */
  charge: ChargePlan;
}

/**
 * Decides a transfer of `amount` points from one user to another.
 *
 * Composes the existing decisions rather than adding new ones: the sender side
 * IS `planSpend` (paid-first, FIFO, fully guarded), and the receiver's charge
 * mirrors that plan's paid/free split so a transfer conserves each kind of
 * point (paid→paid, free→free). The only rule this adds is that the two parties
 * must differ.
 *
 * Total: returns a plan or throws `PointTransferToSelfError` or whatever
 * `planSpend` throws (`InsufficientPointError` / `PointAmountNotPositiveError`).
 */
export function planTransfer(
  fromUserId: number,
  toUserId: number,
  senderWorld: { snapshot: PointSnapshot; charges: readonly ChargeBalance[] },
  amount: number,
): TransferPlan {
  if (fromUserId === toUserId) {
    throw new PointTransferToSelfError(fromUserId);
  }
  const spend = planSpend(senderWorld.snapshot, senderWorld.charges, amount);
  const charge = planCharge({ paidAmount: spend.paidUsage, freeAmount: spend.freeUsage });
  return { spend, charge };
}
