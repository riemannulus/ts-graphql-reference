/**
 * The clock — the app's single seam for reading "now".
 *
 * Reading the current time is an EFFECT (it observes the moving world), so it
 * enters the domain the way the database and the flag reader do: as an injected
 * port, never as an ambient `new Date()` buried inside a decision. A use-case
 * reads `now` ONCE at the top of its read phase and hands it to the pure core as
 * data — the time analogue of loading a world snapshot (see CONVENTIONS §10
 * "Time"). That is what makes a time-sensitive use-case deterministic under test:
 * inject a fixed clock and the same inputs always produce the same result, with
 * no `vi.useFakeTimers` mutating a process-global that the DB clock ignores.
 *
 * The shape mirrors the other ports (`GoogleOAuthClient`, `PostSearchIndex`): a
 * function record with a production binding here and a fake in tests
 * (`src/tests/support/clock.ts`). `systemClock` is bound in the composition root
 * (`createServices` / `buildApp`), never imported by a core, repo, or schema file
 * — the same discipline the lint rules enforce for the db handles and the flag
 * reader (a core cannot import the clock module).
 *
 * It returns a plain `Date` (an instant): the clock MINTS the instant, and any
 * calendar reasoning about it — KST day boundaries, windows, durations — is the
 * separate job of the pure `time.ts` module. Minting and calendar math are
 * deliberately different seams; crepe conflates them in a single `dayjs()` call,
 * which is precisely what makes that code time-sensitive in every file.
 */
export interface Clock {
  /** The current instant — the one source of "now" a use-case may read. */
  now(): Date;
}

/**
 * Production clock: the system wall clock. This is the ONLY sanctioned `new
 * Date()` for "now" in the codebase; it is bound in the composition root and
 * flows to every use-case as the default `Clock`.
 */
export const systemClock: Clock = {
  now: () => new Date(),
};
