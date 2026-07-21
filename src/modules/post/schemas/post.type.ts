import { builder } from '../../../graphql/builder.js';

export function registerPostTypes(): void {
  builder.prismaObject('Post', {
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

  // Post counts on User live HERE, not in user/: they aggregate THIS module's
  // rows, and `prismaObjectField` is the cross-module composition point for
  // read fields (the schema-layer analogue of onboarding's service-level write
  // composition) — the user module never learns what a post is, and neither
  // module's repo gains a dependency. No repo is involved at all: a
  // `relationCount` rides the parent query as a `_count` sub-select, so a list
  // of N users resolves their counts without per-user queries — the reason a
  // per-parent aggregate needs neither a repo call nor a DataLoader (see
  // CONVENTIONS.md "Per-parent reads and aggregates").
  builder.prismaObjectField('User', 'postCount', (t) =>
    t.relationCount('posts', {
      description: 'Number of posts the user has authored.',
    }),
  );
  builder.prismaObjectField('User', 'publishedPostCount', (t) =>
    t.relationCount('posts', {
      // A filtered count stays declarative plugin config (compiled into the
      // same `_count` sub-select) — not a `where` smuggled into a repo.
      where: { published: true },
      description: 'Number of posts the user has published.',
    }),
  );
}
