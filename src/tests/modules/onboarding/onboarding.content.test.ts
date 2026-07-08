import { describe, expect, it } from 'vitest';
import { buildWelcomePost } from '../../../modules/onboarding/onboarding.content.js';

describe('buildWelcomePost', () => {
  it('greets the user by name when present', () => {
    const { title, content } = buildWelcomePost({ name: 'Alice' });
    expect(title).toBe('Welcome!');
    expect(content).toContain('Alice');
  });

  it('falls back to a generic greeting when name is null', () => {
    const { content } = buildWelcomePost({ name: null });
    expect(content).toContain('there');
  });
});
