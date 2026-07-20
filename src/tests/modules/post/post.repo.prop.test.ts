import { fc, test } from '@fast-check/vitest';
import { afterAll, expect } from 'vitest';
import * as postRepo from '../../../modules/post/post.repo.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';
import { arbCreatePostFields } from './post.arbitraries.js';

const prisma = await makeTestPrisma();

afterAll(() => prisma.$disconnect());

// resetDb runs inside each property body: fast-check replays many iterations
// within a single test, so the DB must be cleared per iteration, not once.
async function freshAuthor() {
  await resetDb(prisma);
  return prisma.user.create({ data: { email: 'author@example.com' } });
}

test.prop([arbCreatePostFields])(
  'create persists title/content faithfully and starts unpublished',
  async (fields) => {
    const author = await freshAuthor();
    const created = await postRepo.createPost(prisma, { ...fields, authorId: author.id });

    expect(created.title).toBe(fields.title);
    expect(created.content).toBe(fields.content);
    expect(created.published).toBe(false);

    const found = await postRepo.findById(prisma, created.id);
    expect(found?.title).toBe(fields.title);
    expect(found?.content).toBe(fields.content);
  },
);

test.prop([fc.array(fc.tuple(arbCreatePostFields, fc.boolean()), { maxLength: 8 })])(
  'onlyPublished returns exactly the published subset',
  async (seeds) => {
    const author = await freshAuthor();
    await Promise.all(
      seeds.map(async ([fields, published]) => {
        const post = await postRepo.createPost(prisma, { ...fields, authorId: author.id });
        if (published) await postRepo.publishPost(prisma, post.id);
      }),
    );

    const all = await postRepo.findMany(prisma);
    const onlyPublished = await postRepo.findMany(prisma, {}, { onlyPublished: true });

    expect(all).toHaveLength(seeds.length);
    expect(onlyPublished.every((p) => p.published)).toBe(true);
    expect(onlyPublished).toHaveLength(seeds.filter(([, published]) => published).length);
  },
);
