import type { PrismaClient } from '@prisma/client';
import { createPrismaClient } from '../prisma.js';

export const TEST_DB_FILE = './prisma/test.db';
export const TEST_DATABASE_URL = `file:${TEST_DB_FILE}`;

/** A PrismaClient pointed at the throwaway test database. */
export function makeTestPrisma(): PrismaClient {
  return createPrismaClient(TEST_DATABASE_URL);
}

/** Truncates all tables between tests. Posts first due to the FK to User. */
export async function resetDb(prisma: PrismaClient): Promise<void> {
  await prisma.post.deleteMany();
  await prisma.user.deleteMany();
}
