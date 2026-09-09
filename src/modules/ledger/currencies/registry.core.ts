import type { CurrencyPolicy, CurrencyRegistry } from '../ledger.core.js';
import type { Currency } from '../ledger.value.js';
import { FREE_POINT_POLICY } from './free-point.core.js';
import { INCOME_POLICY } from './income.core.js';
import { MILEAGE_POLICY } from './mileage.core.js';
import { PAID_POINT_POLICY } from './paid-point.core.js';

/**
 * Every currency's policy, in one place — the ONLY file that grows when a
 * currency is added, in the same spirit as `db/lock-registry.ts` and
 * `flags/flag-registry.ts`.
 *
 * The kernel never imports this: `planPosting` takes the registry as a
 * parameter, so it names no currency and a test can hand it a generated one.
 * The binding happens in the composition root, which is why "what currencies
 * exist" is a wiring question rather than something compiled into the rules.
 *
 * `satisfies Record<Currency, …>` makes the record TOTAL: adding a member to
 * `CURRENCIES` without a policy here is a compile error, not a lookup that
 * returns `undefined` at three in the morning.
 */
export const CURRENCY_POLICIES = {
  PAID_POINT: PAID_POINT_POLICY,
  FREE_POINT: FREE_POINT_POLICY,
  INCOME: INCOME_POLICY,
  MILEAGE: MILEAGE_POLICY,
} as const satisfies Record<Currency, CurrencyPolicy>;

/** The registry as the kernel wants it — every currency, one policy each. */
export const currencyRegistry: CurrencyRegistry = CURRENCY_POLICIES;

/** One currency's policy. Total: the registry covers every member by type. */
export function policyOf(currency: Currency): CurrencyPolicy {
  return CURRENCY_POLICIES[currency];
}
