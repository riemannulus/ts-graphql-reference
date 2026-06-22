import { builder } from '../../../builder.js';

export const PostType = builder.prismaObject('Post', {
  fields: (t) => ({
    id: t.exposeID('id'),
    title: t.exposeString('title'),
    content: t.exposeString('content', { nullable: true }),
    published: t.exposeBoolean('published'),
    createdAt: t.string({ resolve: (post) => post.createdAt.toISOString() }),
    // Relation resolved efficiently by the Pothos Prisma plugin.
    author: t.relation('author'),
  }),
});
