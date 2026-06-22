import { fc, test } from '@fast-check/vitest';
import { afterAll, expect } from 'vitest';
import { PostService } from '../../../modules/post/post.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';
import { arbCreatePostFields } from './post.arbitraries.js';

const prisma = makeTestPrisma();
const posts = new PostService(prisma);

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
    const created = await posts.create({ ...fields, authorId: author.id });

    expect(created.title).toBe(fields.title);
    expect(created.content).toBe(fields.content);
    expect(created.published).toBe(false);

    const found = await posts.findById(created.id);
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
        const post = await posts.create({ ...fields, authorId: author.id });
        if (published) await posts.publish(post.id);
      }),
    );

    const all = await posts.findMany();
    const onlyPublished = await posts.findMany({}, { onlyPublished: true });

    expect(all).toHaveLength(seeds.length);
    expect(onlyPublished.every((p) => p.published)).toBe(true);
    expect(onlyPublished).toHaveLength(seeds.filter(([, published]) => published).length);
  },
);
