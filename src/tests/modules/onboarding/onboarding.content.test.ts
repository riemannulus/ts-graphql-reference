import { describe, expect, it } from 'vitest';
import type { User } from '@prisma/client';
import { buildWelcomePost } from '../../../modules/onboarding/onboarding.content.js';

function fakeUser(name: string | null): User {
  return {
    id: 1,
    email: 'u@example.com',
    name,
    status: 'ACTIVE',
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('buildWelcomePost', () => {
  it('greets the user by name when present', () => {
    const { title, content } = buildWelcomePost(fakeUser('Alice'));
    expect(title).toBe('Welcome!');
    expect(content).toContain('Alice');
  });

  it('falls back to a generic greeting when name is null', () => {
    const { content } = buildWelcomePost(fakeUser(null));
    expect(content).toContain('there');
  });
});
