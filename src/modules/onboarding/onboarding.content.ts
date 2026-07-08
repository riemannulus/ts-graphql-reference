export interface WelcomePostContent {
  title: string;
  content: string;
}

/**
 * The welcome post a new user receives on sign-up. Pure core: the input type
 * asks only for what the decision needs (the display name), so any user-shaped
 * value satisfies it structurally and the function stays Prisma-free.
 */
export function buildWelcomePost(user: { name: string | null }): WelcomePostContent {
  const who = user.name ?? 'there';
  return {
    title: 'Welcome!',
    content: `Hi ${who}, welcome aboard. This is your first post — edit or delete it anytime.`,
  };
}
