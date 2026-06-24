import type { Prisma, PrismaClient, Post } from '@prisma/client';

export interface CreatePostInput {
  title: string;
  content?: string | null;
  authorId: number;
}

/**
 * Business logic for posts. PrismaClient is injected via the constructor
 * (see app.ts). Read methods spread the Pothos `query` selection to preserve
 * the prisma plugin's relation-loading optimization.
 */
export class PostService {
  constructor(private readonly prisma: PrismaClient) {}

  findById(id: number, query: Prisma.PostDefaultArgs = {}): Promise<Post | null> {
    return this.prisma.post.findUnique({ ...query, where: { id } });
  }

  findMany(
    query: Prisma.PostFindManyArgs = {},
    opts: { onlyPublished?: boolean } = {},
  ): Promise<Post[]> {
    return this.prisma.post.findMany({
      orderBy: { createdAt: 'desc' },
      ...query,
      ...(opts.onlyPublished ? { where: { published: true } } : {}),
    });
  }

  create(
    input: CreatePostInput,
    query: Prisma.PostDefaultArgs = {},
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<Post> {
    return client.post.create({
      ...query,
      data: {
        title: input.title,
        content: input.content ?? null,
        author: { connect: { id: input.authorId } },
      },
    });
  }

  publish(id: number, query: Prisma.PostDefaultArgs = {}): Promise<Post> {
    return this.prisma.post.update({ ...query, where: { id }, data: { published: true } });
  }
}
