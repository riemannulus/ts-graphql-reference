import { randomBytes } from 'node:crypto';

/**
 * The randomness seam — the app's single source of unpredictable bytes.
 *
 * Drawing a random number is an EFFECT for the same reason reading the wall
 * clock is (`clock.ts`): it observes something outside the decision, so the same
 * inputs would otherwise produce different outputs and no test could pin them
 * down. It therefore enters exactly the way `now` does — an injected port with
 * ONE production binding here, bound in the composition root, never an ambient
 * `randomBytes` call buried inside a use-case.
 *
 * The port deals in BYTES rather than in ids or tokens. What those bytes mean —
 * a reference id's suffix, a nonce, a shuffle — is a domain question that
 * belongs to the domain, and keeping it out of here is what stops this file
 * accumulating one method per caller.
 */
export interface Random {
  /** `count` cryptographically strong bytes. */
  bytes(count: number): Uint8Array;
}

/**
 * Production binding: the platform CSPRNG. This is the ONLY sanctioned
 * `node:crypto` randomness call in the codebase, mirroring `systemClock`.
 */
export const systemRandom: Random = {
  bytes: (count) => randomBytes(count),
};
