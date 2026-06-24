# Onboarding Welcome-Post Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** GraphQL `signUp` mutation creates a user and a default welcome post atomically, owned by a new `onboarding` module that orchestrates the user and post services.

**Architecture:** A new `OnboardingService` (injected with `UserService`, `PostService`, and `PrismaClient`) runs `users.create` + `posts.create` inside one `prisma.$transaction`. The onboarding module owns its own `signUp` mutation; the user module knows nothing about onboarding (one-way dependency `onboarding → {user, post}`). The existing `createUser` mutation is removed so `signUp` is the sole GraphQL user-creation path.

**Tech Stack:** TypeScript (ESM), Fastify + GraphQL Yoga + Pothos (code-first), Prisma 7 (driver adapter), Vitest + in-process PGlite.

## Global Constraints

- **ESM + `.js` import extensions**: all relative imports end in `.js` (e.g. `'../user/user.service.js'`).
- **Quote style**: single quotes, matching the committed codebase.
- **Schema files never import service classes**: import only `builder`; call business logic via `ctx.services.*`. Never `import { XService }` into a `schemas/*.ts` file.
- **No Prisma schema change**: the welcome post is an ordinary `Post`; do NOT edit `prisma/schema.prisma` or run migrations / `prisma generate`.
- **Service container is the single registration point**: register new services only in `src/context.ts::createServices`; `Services` type derives from its return value automatically.
- **Only `create` methods gain the transaction param**: do not change `findById`/`findMany`/`changeStatus`/`publish` signatures.
- **Default param keeps backward compatibility**: `client: Prisma.TransactionClient = this.prisma` — existing callers pass nothing and are unaffected.
- **Welcome post copy**: `title: 'Welcome!'`; body references the user's name (fallback `'there'`).
- **`signUp` returns the existing `UserType`** — no new GraphQL object type.
- **OAuth path unchanged**: `UserService.findOrCreateByEmail` does NOT create a welcome post.
- **Test conventions** (see existing files): top-level `const prisma = await makeTestPrisma();`, `beforeEach(() => resetDb(prisma))`, `afterAll(() => prisma.$disconnect())` (or `app.close()` for e2e). Test files live under `src/tests/**/*.test.ts`.
- **Run a single test file**: `pnpm vitest run <path>`. Filter by name: `pnpm vitest run <path> -t "<name>"`.

---

### Task 1: Confirm PGlite supports interactive transactions (de-risk)

The whole design assumes `prisma.$transaction(async (tx) => …)` rolls back on the PGlite test adapter (`pglite-prisma-adapter`). Prove it first with a tiny standalone test. **If this test cannot be made to pass, STOP** and report back — the fallback is best-effort (no transaction), which changes Task 4.

**Files:**
- Test: `src/tests/integrations/transaction-support.test.ts` (create)

**Interfaces:**
- Consumes: `makeTestPrisma`, `resetDb` from `src/tests/support/helpers.js`.
- Produces: nothing consumed by later tasks (a standalone capability guard).

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Guards a load-bearing assumption: the PGlite driver adapter must support
// Prisma interactive transactions so onboarding can create a user + welcome
// post atomically (see OnboardingService).
const prisma = await makeTestPrisma();

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('PGlite interactive transactions', () => {
  it('commits when the callback succeeds', async () => {
    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { email: 'commit@example.com' } });
    });
    expect(await prisma.user.count()).toBe(1);
  });

  it('rolls back every write when the callback throws', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.user.create({ data: { email: 'rollback@example.com' } });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.user.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm vitest run src/tests/integrations/transaction-support.test.ts`
Expected: **PASS** (2 passed). If it FAILS with a "transactions not supported"/"interactive transaction" style error, STOP and report — switch to the best-effort fallback per spec §10.

- [ ] **Step 3: Commit**

```bash
git add src/tests/integrations/transaction-support.test.ts
git commit -m "test: confirm PGlite adapter supports interactive transactions"
```

---

### Task 2: Make `UserService.create` and `PostService.create` transaction-capable

Add an optional `client` parameter so the create runs against a passed transaction client when present, defaulting to the injected `PrismaClient`. Existing callers are unaffected.

**Files:**
- Modify: `src/modules/user/user.service.ts` (the `create` method, ~lines 29-36)
- Modify: `src/modules/post/post.service.ts` (the `create` method, ~lines 32-41)
- Test: `src/tests/modules/user/user.service.test.ts` (add one test) and `src/tests/modules/post/post.service.test.ts` (add one test)

**Interfaces:**
- Produces:
  - `UserService.create(input: CreateUserInput, query?: Prisma.UserDefaultArgs, client?: Prisma.TransactionClient): Promise<User>`
  - `PostService.create(input: CreatePostInput, query?: Prisma.PostDefaultArgs, client?: Prisma.TransactionClient): Promise<Post>`

- [ ] **Step 1: Write the failing tests**

Add to `src/tests/modules/user/user.service.test.ts` (inside the existing `describe('UserService', …)` block; the file already has `const prisma = await makeTestPrisma(); const users = new UserService(prisma);`):

```ts
  it('create participates in a passed transaction and rolls back with it', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await users.create({ email: 'tx@example.com' }, {}, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.user.count()).toBe(0);
  });
```

Add to `src/tests/modules/post/post.service.test.ts` (inside the existing `describe('PostService', …)` block):

```ts
  it('create participates in a passed transaction and rolls back with it', async () => {
    const author = await makeAuthor();
    await expect(
      prisma.$transaction(async (tx) => {
        await posts.create({ title: 'tx', authorId: author.id }, {}, tx);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await prisma.post.count()).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/tests/modules/user/user.service.test.ts src/tests/modules/post/post.service.test.ts -t "participates in a passed transaction"`
Expected: **FAIL** — TypeScript/argument error (`create` accepts only 2 args), or the write is not transactional so `count()` is 1.

- [ ] **Step 3: Add the `client` parameter to `UserService.create`**

In `src/modules/user/user.service.ts`, replace the `create` method with:

```ts
  create(
    input: CreateUserInput,
    query: Prisma.UserDefaultArgs = {},
    client: Prisma.TransactionClient = this.prisma,
  ): Promise<User> {
    // Parse at the boundary: an invalid email never reaches the database.
    const email = parseEmail(input.email);
    return client.user.create({
      ...query,
      data: { email, name: input.name ?? null },
    });
  }
```

(`Prisma` is already imported: `import type { Prisma, PrismaClient, User } from '@prisma/client';`.)

- [ ] **Step 4: Add the `client` parameter to `PostService.create`**

In `src/modules/post/post.service.ts`, replace the `create` method with:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/tests/modules/user/user.service.test.ts src/tests/modules/post/post.service.test.ts`
Expected: **PASS** (all tests in both files, including the new ones).

- [ ] **Step 6: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/modules/user/user.service.ts src/modules/post/post.service.ts src/tests/modules/user/user.service.test.ts src/tests/modules/post/post.service.test.ts
git commit -m "feat: allow create() to run inside a passed transaction"
```

---

### Task 3: `buildWelcomePost` pure function

The onboarding module's own domain logic: given a user, produce the welcome post's title and content.

**Files:**
- Create: `src/modules/onboarding/onboarding.content.ts`
- Test: `src/tests/modules/onboarding/onboarding.content.test.ts` (create; new directory)

**Interfaces:**
- Produces: `buildWelcomePost(user: User): { title: string; content: string }` and the `WelcomePostContent` interface.

- [ ] **Step 1: Write the failing test**

```ts
// src/tests/modules/onboarding/onboarding.content.test.ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/tests/modules/onboarding/onboarding.content.test.ts`
Expected: **FAIL** — cannot find module `onboarding.content.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/onboarding/onboarding.content.ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/tests/modules/onboarding/onboarding.content.test.ts`
Expected: **PASS** (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/modules/onboarding/onboarding.content.ts src/tests/modules/onboarding/onboarding.content.test.ts
git commit -m "feat: add buildWelcomePost content helper"
```

---

### Task 4: `OnboardingService.register` (transactional orchestration)

The core: create the user and the welcome post in one interactive transaction.

**Files:**
- Create: `src/modules/onboarding/onboarding.service.ts`
- Test: `src/tests/modules/onboarding/onboarding.service.test.ts` (create)

**Interfaces:**
- Consumes: `UserService.create(input, query?, client?)` and `PostService.create(input, query?, client?)` (Task 2); `buildWelcomePost(user)` (Task 3); `CreateUserInput` interface from `../user/user.service.js`.
- Produces:
  - `class OnboardingService` with constructor `({ users: UserService; posts: PostService; prisma: PrismaClient })`
  - `register(input: CreateUserInput, query?: Prisma.UserDefaultArgs): Promise<User>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/tests/modules/onboarding/onboarding.service.test.ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { OnboardingService } from '../../../modules/onboarding/onboarding.service.js';
import { PostService } from '../../../modules/post/post.service.js';
import { UserService } from '../../../modules/user/user.service.js';
import { makeTestPrisma, resetDb } from '../../support/helpers.js';

const prisma = await makeTestPrisma();
const users = new UserService(prisma);
const posts = new PostService(prisma);
const onboarding = new OnboardingService({ users, posts, prisma });

beforeEach(() => resetDb(prisma));
afterAll(() => prisma.$disconnect());

describe('OnboardingService.register', () => {
  it('creates the user and a welcome post authored by them', async () => {
    const user = await onboarding.register({ email: 'alice@example.com', name: 'Alice' });

    expect(user.email).toBe('alice@example.com');

    const userPosts = await prisma.post.findMany({ where: { authorId: user.id } });
    expect(userPosts).toHaveLength(1);
    expect(userPosts[0]?.title).toBe('Welcome!');
    expect(userPosts[0]?.content).toContain('Alice');
  });

  it('rolls back the user when welcome-post creation fails', async () => {
    // Inject a PostService whose create always throws, so the transaction aborts.
    const failingPosts = {
      create: () => Promise.reject(new Error('post failed')),
    } as unknown as PostService;
    const failing = new OnboardingService({ users, posts: failingPosts, prisma });

    await expect(failing.register({ email: 'bob@example.com' })).rejects.toThrow('post failed');

    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.post.count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/tests/modules/onboarding/onboarding.service.test.ts`
Expected: **FAIL** — cannot find module `onboarding.service.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/modules/onboarding/onboarding.service.ts
import type { Prisma, PrismaClient, User } from '@prisma/client';
import type { PostService } from '../post/post.service.js';
import type { CreateUserInput, UserService } from '../user/user.service.js';
import { buildWelcomePost } from './onboarding.content.js';

interface OnboardingServiceDeps {
  users: UserService;
  posts: PostService;
  prisma: PrismaClient;
}

/**
 * Orchestrates sign-up across the user and post modules. This module depends on
 * UserService and PostService, never the other way round — the same one-way
 * shape as OAuthService → UserService (see context.ts).
 */
export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  /**
   * Creates a user and their default welcome post in a single interactive
   * transaction: if the welcome post fails, the user is rolled back too.
   *
   * Returns the created user; a `signUp { posts { ... } }` selection sees the
   * welcome post because Pothos resolves the relation after the transaction
   * commits.
   */
  register(input: CreateUserInput, _query: Prisma.UserDefaultArgs = {}): Promise<User> {
    return this.deps.prisma.$transaction(async (tx) => {
      const user = await this.deps.users.create(input, {}, tx);
      const { title, content } = buildWelcomePost(user);
      await this.deps.posts.create({ authorId: user.id, title, content }, {}, tx);
      return user;
    });
  }
}
```

> Note: `_query` is accepted to mirror the resolver's Pothos `query` argument and reserve the seam for re-reading with selections if Task 5's e2e shows the relation isn't resolved post-commit. It is intentionally unused for now (underscore prefix).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/tests/modules/onboarding/onboarding.service.test.ts`
Expected: **PASS** (2 passed).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/modules/onboarding/onboarding.service.ts src/tests/modules/onboarding/onboarding.service.test.ts
git commit -m "feat: add OnboardingService.register (transactional user + welcome post)"
```

---

### Task 5: Expose `signUp`, remove `createUser`, wire the container

Register `OnboardingService` in the container, add the `signUp` mutation, remove the `createUser` mutation + its `CreateUserInput` GraphQL input, and update the existing e2e test (which currently uses `createUser`).

**Files:**
- Create: `src/modules/onboarding/schemas/onboarding.mutation.ts`
- Modify: `src/context.ts` (`createServices`, ~lines 28-36)
- Modify: `src/schema.ts` (add registration import)
- Modify: `src/modules/user/user.schema.ts` (remove `createUser` + `CreateUserInput`; clean imports/quote-style)
- Modify: `src/tests/e2e/graphql.test.ts` (replace `createUser` usage with `signUp`)

**Interfaces:**
- Consumes: `OnboardingService` + `register(...)` (Task 4).
- Produces: GraphQL `signUp(input: SignUpInput!): User!`; `ctx.services.onboarding` available to all resolvers.

- [ ] **Step 1: Write the failing e2e test (rewrite the existing file)**

Replace the entire contents of `src/tests/e2e/graphql.test.ts` with:

```ts
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../app.js';
import { makeTestPrisma, resetDb } from '../support/helpers.js';

// Inject a test-DB-backed client; buildApp wires it through the GraphQL context.
const prisma = await makeTestPrisma();
const { app } = buildApp({ prisma, logger: false });

interface GqlResult {
  data?: Record<string, any>;
  errors?: Array<{ message: string; extensions?: Record<string, any> }>;
}

async function gql(query: string, variables?: Record<string, unknown>): Promise<GqlResult> {
  const res = await app.inject({
    method: 'POST',
    url: '/graphql',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ query, variables }),
  });
  return res.json() as GqlResult;
}

beforeEach(() => resetDb(prisma));
afterAll(() => app.close()); // onClose hook disconnects prisma

describe('GraphQL API', () => {
  it('signUp creates a user with a welcome post', async () => {
    const res = await gql(
      'mutation ($e: String!) { signUp(input: { email: $e, name: "Alice" }) { id email posts { title } } }',
      { e: 'a@b.com' },
    );
    expect(res.errors).toBeUndefined();
    expect(res.data?.signUp.email).toBe('a@b.com');
    expect(res.data?.signUp.posts).toHaveLength(1);
    expect(res.data?.signUp.posts[0].title).toBe('Welcome!');
  });

  it('no longer exposes createUser', async () => {
    const res = await gql('mutation { createUser(input: { email: "z@z.com" }) { id } }');
    expect(res.errors?.[0]?.message).toMatch(/createUser/);
  });

  it('surfaces an illegal status transition as a domain error', async () => {
    const created = await gql('mutation { signUp(input: { email: "x@y.com" }) { id } }');
    const id = Number(created.data?.signUp.id);

    await gql(`mutation { changeUserStatus(id: ${id}, status: DEACTIVATED) { status } }`);
    const res = await gql(`mutation { changeUserStatus(id: ${id}, status: ACTIVE) { status } }`);

    expect(res.data?.changeUserStatus).toBeNull();
    expect(res.errors?.[0]?.extensions?.code).toBe('INVALID_STATUS_TRANSITION');
  });
});
```

- [ ] **Step 2: Run the e2e test to verify it fails**

Run: `pnpm vitest run src/tests/e2e/graphql.test.ts`
Expected: **FAIL** — `signUp` is not a known mutation field (first test fails; `no longer exposes createUser` passes only after Step 5).

- [ ] **Step 3: Create the `signUp` mutation**

```ts
// src/modules/onboarding/schemas/onboarding.mutation.ts
import { builder } from '../../../builder.js';

const SignUpInput = builder.inputType('SignUpInput', {
  fields: (t) => ({
    email: t.string({ required: true }),
    name: t.string({ required: false }),
  }),
});

builder.mutationField('signUp', (t) =>
  t.prismaField({
    type: 'User',
    args: { input: t.arg({ type: SignUpInput, required: true }) },
    resolve: (query, _root, args, ctx) =>
      ctx.services.onboarding.register(
        { email: args.input.email, name: args.input.name },
        query,
      ),
  }),
);
```

- [ ] **Step 4: Register `OnboardingService` in the container**

In `src/context.ts`, add the import near the other service imports:

```ts
import { OnboardingService } from './modules/onboarding/onboarding.service.js';
```

Then in `createServices`, add `onboarding` after `auth` and include it in the return:

```ts
  const auth = new OAuthService({
    users: user,
    google: options.googleOAuth ?? new StubGoogleOAuthClient(),
  });
  const onboarding = new OnboardingService({ users: user, posts: post, prisma });
  return { user, post, auth, onboarding };
```

- [ ] **Step 5: Register the mutation and remove `createUser`**

In `src/schema.ts`, add after the post mutation import:

```ts
import './modules/onboarding/schemas/onboarding.mutation.js';
```

In `src/modules/user/user.schema.ts`:
- Remove the unused imports `import { PostService } from '../post/post.service.js';` and `import { UserService } from './user.service.js';` (present in the working tree).
- Ensure the remaining imports use single quotes: `import { builder } from '../../builder.js';` and `import { USER_STATUSES, type UserStatus } from './user.state.js';`.
- Delete the `CreateUserInput` input type block:

```ts
const CreateUserInput = builder.inputType('CreateUserInput', {
  fields: (t) => ({
    email: t.string({ required: true }),
    name: t.string({ required: false }),
  }),
});
```

- Delete the `createUser` mutation block:

```ts
builder.mutationField('createUser', (t) =>
  t.prismaField({
    type: 'User',
    args: { input: t.arg({ type: CreateUserInput, required: true }) },
    resolve: (query, _root, args, ctx) =>
      ctx.services.user.create({ email: args.input.email, name: args.input.name }, query),
  }),
);
```

Leave `UserType`, the `user`/`users` queries, and `changeUserStatus` intact (restore them to single-quote style if the working tree changed them to double quotes). Do NOT touch the `CreateUserInput` TS interface in `user.service.ts` — it stays (used by OAuth and onboarding).

- [ ] **Step 6: Run the e2e test to verify it passes**

Run: `pnpm vitest run src/tests/e2e/graphql.test.ts`
Expected: **PASS** (3 passed). If `signUp { posts }` returns an empty array (welcome post missing from the same response), apply the spec §10 contingency: have `register` re-read the user with the Pothos selection inside the transaction — change the last line of `register` to:

```ts
      return tx.user.findUniqueOrThrow({ ..._query, where: { id: user.id } });
```

rename `_query` → `query` in the signature, then re-run.

- [ ] **Step 7: Typecheck and full test suite**

Run: `pnpm typecheck && pnpm vitest run`
Expected: no type errors; all test files pass.

- [ ] **Step 8: Lint**

Run: `pnpm lint`
Expected: no errors. (If oxlint flags the `as unknown as PostService` cast in Task 4's test or an unused var, address minimally.)

- [ ] **Step 9: Commit**

```bash
git add src/modules/onboarding/schemas/onboarding.mutation.ts src/context.ts src/schema.ts src/modules/user/user.schema.ts src/tests/e2e/graphql.test.ts
git commit -m "feat: add signUp mutation and remove createUser"
```

---

## Notes for the implementer

- **Pre-existing working-tree churn**: before this work began, `src/modules/post/schemas/post.mutation.ts` and `src/modules/user/user.schema.ts` had uncommitted style changes (single→double quotes) plus unused imports in `user.schema.ts`. Task 5 cleans `user.schema.ts`. `post.mutation.ts` is not part of this feature — leave it as-is (do not add it to any commit). If `pnpm lint` flags it, mention it but do not fix it under this plan.
- **No schema/migration work**: the welcome post uses the existing `Post` model. Do not run `prisma migrate` or `prisma generate`.

## Self-Review

**Spec coverage** (against `2026-06-24-onboarding-welcome-post-design.md`):
- §5.1 service create + client param → Task 2 ✓
- §5.2 OnboardingService.register transaction → Task 4 ✓
- §5.3 buildWelcomePost → Task 3 ✓
- §5.4 signUp mutation → Task 5 ✓
- §5.5 remove createUser/CreateUserInput, clean imports → Task 5 ✓
- §5.6 context.ts + schema.ts wiring → Task 5 ✓
- §7 error handling (rollback, domain errors) → Task 4 rollback test + Task 5 status-transition test ✓
- §8 Step 0 characterization → Task 1; unit → Tasks 3,4; e2e → Task 5 ✓
- §9 OAuth untouched → enforced by not modifying it (Global Constraints) ✓
- §10 risk 1 (PGlite tx) → Task 1 gate; risk 2 (Pothos relation) → Task 5 Step 6 contingency ✓

**Placeholder scan**: no TBD/TODO; every code step shows full code. ✓

**Type consistency**: `create(input, query?, client?: Prisma.TransactionClient)` consistent across Tasks 2/4; `OnboardingService` constructor `{ users, posts, prisma }` and `register(input, query?)` consistent across Tasks 4/5; `buildWelcomePost(user): { title, content }` consistent across Tasks 3/4. ✓
