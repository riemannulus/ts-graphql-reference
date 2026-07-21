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
 */
import { defineFlags, gate, variant, type FlagReader as FlagReaderOf } from './flags.js';

/** The ONLY declaration of the app's flags. Add an entry to gate a new capability. */
export const FLAGS = defineFlags({
  /**
   * MODE 2 — kill / rollout gate. `point.transfer` runs only when a LIVE
   * `FeatureFlag` row named `pointTransfer` exists for the deploy STAGE and is
   * inside its enable/disable window; absent / out-of-window / wrong-stage /
   * soft-deleted ⇒ `FeatureDisabledError`. Flip off by soft-deleting the row or
   * setting `disableAfter` to now. Default `false` = crepe safe-default INACTIVE
   * (a missing backend fails the gate closed). Read via `flags.assert.pointTransfer()`.
   */
  pointTransfer: gate(false, 'Enablement gate for peer-to-peer point transfers.'),

  /**
   * MODE 1 — rule change, read as DATA (not asserted). When on, `point.transfer`
   * spends the sender's FREE points before paid ones; the branch lives in the pure
   * core (`planSpend`), which the service feeds this boolean. Default `false` =
   * the standard paid-first policy. Read via `flags.pointTransferPreferFree()`.
   */
  pointTransferPreferFree: gate(false, 'Spend free points before paid ones on a transfer.'),

  /**
   * MODE 3 — implementation swap. Selects which welcome post a new user receives;
   * the onboarding core picks the builder from an exhaustive `Record<Variant, …>`,
   * so a new variant without an implementation is a compile error. Default
   * `classic` = the original copy. Read via `flags.welcomeVariant()`.
   */
  welcomeVariant: variant(['classic', 'festive', 'minimal'], 'classic', 'Welcome-post copy variant.'),
});

/** The registered flag names, derived from the registry. */
export type FlagName = keyof typeof FLAGS;

/** The typed reader for this registry — the type of `ctx.flags` (see `flag-reader.ts`). */
export type FlagReader = FlagReaderOf<typeof FLAGS>;
