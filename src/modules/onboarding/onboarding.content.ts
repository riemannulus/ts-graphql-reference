import type { User } from '@prisma/client';

export interface WelcomePostContent {
  title: string;
  content: string;
}

/**
 * The welcome post a new user receives on sign-up. Kept as a pure function so
 * the onboarding module owns its copy and it can be unit-tested in isolation.
 */
export function buildWelcomePost(user: User): WelcomePostContent {
  const who = user.name ?? 'there';
  return {
    title: 'Welcome!',
    content: `Hi ${who}, welcome aboard. This is your first post — edit or delete it anytime.`,
  };
}
