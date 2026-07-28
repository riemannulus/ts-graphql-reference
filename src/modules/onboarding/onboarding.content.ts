export interface WelcomePostContent {
  title: string;
  content: string;
}

/**
 * The welcome-post copy variants — the SINGLE declaration of the set, owned by
 * the module that owns the implementations below. `flag-registry.ts` imports THIS
 * list for the `welcomeVariant` spec rather than repeating the literal, so the
 * flag's choices and the builders can never disagree: adding a variant here makes
 * the record below non-exhaustive (a compile error in this file) and the flag
 * picks the new choice up for free. The dependency runs registry → core only; a
 * core may not import the flag facade (lint), which is what keeps it acyclic.
 */
export const WELCOME_VARIANTS = ['classic', 'festive', 'minimal'] as const;
export type WelcomeVariant = (typeof WELCOME_VARIANTS)[number];

type WelcomeBuilder = (user: { name: string | null }) => WelcomePostContent;

/**
 * One welcome-post builder per variant — the reference's "implementation swap"
 * flag example (mode 3). The service reads the `welcomeVariant` flag and selects
 * from THIS record; because it is a total `Record<WelcomeVariant, …>`, adding a
 * variant to the set without a builder here is a compile error — exhaustiveness
 * by the type, never an if-chain. Pure core: each builder asks only for the
 * display name, so any user-shaped value satisfies it structurally.
 */
export const welcomePostBuilders: Record<WelcomeVariant, WelcomeBuilder> = {
  classic: (user) => ({
    title: 'Welcome!',
    content: `Hi ${user.name ?? 'there'}, welcome aboard. This is your first post — edit or delete it anytime.`,
  }),
  festive: (user) => ({
    title: '🎉 Welcome aboard!',
    content: `Hey ${user.name ?? 'there'} — so glad you're here! This is your first post; make it your own.`,
  }),
  minimal: (user) => ({
    title: 'Welcome',
    content: `Hi ${user.name ?? 'there'}. Your account is ready.`,
  }),
};

/**
 * Builds the welcome post for a variant. Defaults to `classic` (the original
 * copy), so callers that do not gate on the flag get the historical behaviour.
 */
export function buildWelcomePost(
  user: { name: string | null },
  variant: WelcomeVariant = 'classic',
): WelcomePostContent {
  return welcomePostBuilders[variant](user);
}
