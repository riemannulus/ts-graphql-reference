/**
 * The feature-flag registry — the ONE place that says WHAT is flag-gated, kept
 * apart from the machinery (`flags.ts`) and the client binding (`flag-reader.ts`)
 * so this is the only file that grows. Each entry is one flag: its kind and its
 * default (the value callers see when no live rule backs it). Add a flag here;
 * `flags.ts` and `flag-reader.ts` do not change.
 *
 * Like `flags.ts`, this module stays pure — no I/O, no SDK, no framework deps
 * (lint-enforced). It is the `lock-registry.ts` analogue: the growing catalog on
 * top of fixed machinery.
 *
 * Every entry declares its LIFECYCLE (see `flags.ts`): `permanent` for a flag
 * the registry may keep indefinitely, `temporary('YYYY-MM-DD')` for one that
 * must be deleted — entry and call sites — by that KST day. Past the deadline
 * `flag-hygiene.test.ts` fails the build; deleting the entry then turns every
 * remaining call site into a compile error, which is the point: the DB purge
 * job retires rows, this retires code. The reference's `removeBy` dates are set
 * far ahead so the worked examples stay green; a real app sets the real
 * rollout/experiment deadline.
 */
import { defineFlags, gate, permanent, temporary, variant, type FlagReader as FlagReaderOf } from './flags.js';

/** The ONLY declaration of the app's flags. Add an entry to gate a new capability. */
export const FLAGS = defineFlags({
  /**
   * MODE 2 — kill / rollout gate. `point.transfer` runs only when a LIVE
   * `FeatureFlag` row named `pointTransfer` exists for the deploy STAGE and is
   * inside its enable/disable window; absent / out-of-window / wrong-stage /
   * soft-deleted ⇒ `FeatureDisabledError`. Flip off by soft-deleting the row or
   * setting `disableAfter` to now. Default `false` = crepe safe-default INACTIVE
   * (a missing backend fails the gate closed). Read via `flags.assert.pointTransfer()`.
   *
   * TEMPORARY: a rollout gate ends with the rollout — when transfers are GA,
   * delete this entry and the `assert` call (keep a `permanent` kill switch
   * instead if operations still wants one).
   */
  pointTransfer: gate(false, 'Enablement gate for peer-to-peer point transfers.', temporary('2030-12-31')),

  /**
   * MODE 1 — rule change, read as DATA (not asserted). When on, `point.transfer`
   * spends the sender's FREE points before paid ones; the branch lives in the pure
   * core (`planSpend`), which the service feeds this boolean. Default `false` =
   * the standard paid-first policy. Read via `flags.pointTransferPreferFree()`.
   *
   * TEMPORARY: a rule experiment — by `removeBy`, either the new ordering has
   * won (fold it into `planSpend` as the rule and delete the flag) or it lost
   * (delete the branch and the flag).
   */
  pointTransferPreferFree: gate(false, 'Spend free points before paid ones on a transfer.', temporary('2030-12-31')),

  /**
   * MODE 3 — implementation swap. Selects which welcome post a new user receives;
   * the onboarding core picks the builder from an exhaustive `Record<Variant, …>`,
   * so a new variant without an implementation is a compile error. Default
   * `classic` = the original copy. Read via `flags.welcomeVariant()`.
   *
   * PERMANENT: a long-lived content knob (seasonal copy comes and goes), not a
   * rollout — there is no future day on which this selector is "done".
   */
  welcomeVariant: variant(['classic', 'festive', 'minimal'], 'classic', 'Welcome-post copy variant.', permanent),
});

/** The registered flag names, derived from the registry. */
export type FlagName = keyof typeof FLAGS;

/** The typed reader for this registry — the type of `ctx.flags` (see `flag-reader.ts`). */
export type FlagReader = FlagReaderOf<typeof FLAGS>;
