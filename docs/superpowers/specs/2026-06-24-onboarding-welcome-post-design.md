# Onboarding 모듈: 가입 시 Welcome Post 자동 생성 — 설계

- **날짜**: 2026-06-24
- **브랜치**: `feat/onboarding-welcome-post`
- **상태**: 설계 승인됨, 구현 계획 대기

## 1. 목표

사용자가 GraphQL로 가입할 때, 그 사용자를 author로 하는 기본 **welcome post**를 자동으로 함께 생성한다. 이 동작은 user/post 두 모듈을 오케스트레이션하는 **신규 `onboarding` 모듈**이 책임진다.

## 2. 배경 (현재 구조)

- 스택: Fastify + GraphQL Yoga + **Pothos**(코드 우선 스키마) + **Prisma 7**. 프로덕션은 `@prisma/adapter-pg`, 테스트는 `pglite-prisma-adapter`(인프로세스 PGlite).
- 모듈 패턴: `src/modules/{feature}/`에 `*.service.ts`(생성자로 `PrismaClient` 주입), `*.value.ts`, `*.state.ts`, `schemas/*.ts`(Pothos 등록).
- **서비스 컨테이너**: `src/context.ts`의 `createServices()`가 모든 서비스를 등록·조립하는 유일한 지점. `Services` 타입이 여기서 파생되어 GraphQL `Context`로 자동 전파.
- **레졸버 규칙**: schema 파일은 service 클래스를 직접 import하지 않는다. `builder`만 import하고 비즈니스 로직은 `ctx.services.*`로 호출한다. `builder.ts`는 `Context`를 `import type`(런타임 제거)으로만 가져와 의도적으로 import 순환을 차단한다.
- **기존 오케스트레이션 선례**: `OAuthService`가 `UserService`를 생성자 주입받아 `findOrCreateByEmail()`을 호출한다(`context.ts:31-34`). REST 진입점(`oauth.route.ts`)이 자기 표면을 따로 갖고 user를 프로비저닝한다 — `createUser`를 수정하지 않는다.
- **현재 없는 것**: 이벤트 버스/pub-sub 없음, `$transaction` 사용처 없음(user 생성은 fire-and-forget).
- user 생성 경로: ① `createUser` GraphQL mutation → `UserService.create()`, ② OAuth 콜백 → `UserService.findOrCreateByEmail()`(upsert, 재로그인 멱등).

## 3. 핵심 설계 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 연동 방식 | **직접 오케스트레이션** (신규 `OnboardingService`가 User/Post 서비스 주입) | 이벤트 버스가 없는 레포에 새 패턴을 도입하지 않고, OAuth→User 선례와 동일한 모양 유지 |
| 소유권 / 진입점 | onboarding 모듈이 **자기 mutation `signUp`을 소유**. user 모듈은 onboarding을 모름 | "계층 역전" 회피. 의존은 단방향 `onboarding → {user, post}` |
| `createUser` 처리 | **제거**. `signUp`이 유일한 GraphQL 사용자 생성 경로 | API 표면 단순화 |
| 적용 범위 | **GraphQL `signUp`만**. OAuth 경로는 welcome post 대상 아님 | 범위 한정 |
| 원자성 | **interactive transaction**으로 원자적 (user + welcome post 둘 다 성공 또는 둘 다 롤백) | 절반만 성공한 가입 상태를 방지. 레포에 없던 `$transaction` 패턴을 교육적으로 도입 |

### 왜 "환형 import"가 아니라 "계층 역전"인가
`createUser`(user 모듈) 레졸버가 `ctx.services.onboarding`을 호출해도 레졸버는 service를 import하지 않으므로 **런타임 import 순환은 없다**. 그러나 user 모듈이 onboarding에, onboarding이 user에 의존하는 양방향 결합(계층 역전)이 남는다. onboarding이 **자기 mutation을 소유**하면 user 모듈은 onboarding을 전혀 모르는 leaf로 유지되어 의존이 단방향이 된다.

```
schema.ts ──(side-effect import)──▶ user.schema / post.* / onboarding.mutation
                                      └─ 전부 builder만 import, 호출은 ctx.services 로
builder.ts ──(import type)──▶ context.ts ──(value)──▶ User/Post/OAuth/Onboarding Service
                                                         OnboardingService ──(type)──▶ User/Post Service
```

## 4. 모듈 구조 (신규)

```
src/modules/onboarding/
├── onboarding.service.ts        # OnboardingService.register() — 트랜잭션 오케스트레이션
├── onboarding.content.ts        # buildWelcomePost(user) → { title, content } (순수 함수)
└── schemas/
    └── onboarding.mutation.ts   # signUp mutation → ctx.services.onboarding.register()
```

## 5. 컴포넌트별 설계

### 5.1 서비스 계층 트랜잭션 대응 (소폭 확장, 하위 호환)

`UserService.create`와 `PostService.create`에 선택적 client 파라미터를 추가한다. `PrismaClient`는 구조적으로 `Prisma.TransactionClient`에 할당 가능하므로 기본값이 성립하고, **기존 호출부는 변경 없이 동작**한다.

```ts
// user.service.ts (post.service.ts도 동일 패턴)
create(
  input: CreateUserInput,
  query: Prisma.UserDefaultArgs = {},
  client: Prisma.TransactionClient = this.prisma,   // ← 추가
): Promise<User> {
  const email = parseEmail(input.email);
  return client.user.create({ ...query, data: { email, name: input.name ?? null } });
}
```

> 참고: 트랜잭션이 필요 없는 다른 메서드(`findById`, `findMany`, `changeStatus`, `publish` 등)는 이번 범위에서 손대지 않는다. `create`만 확장한다.

### 5.2 OnboardingService

```ts
import type { Prisma, PrismaClient, User } from '@prisma/client';
import type { CreateUserInput, UserService } from '../user/user.service.js';
import type { PostService } from '../post/post.service.js';
import { buildWelcomePost } from './onboarding.content.js';

interface OnboardingServiceDeps {
  users: UserService;
  posts: PostService;
  prisma: PrismaClient;
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  /** 사용자를 생성하고 같은 트랜잭션 안에서 welcome post를 함께 생성한다. */
  register(input: CreateUserInput, query: Prisma.UserDefaultArgs = {}): Promise<User> {
    return this.deps.prisma.$transaction(async (tx) => {
      const user = await this.deps.users.create(input, {}, tx);
      const { title, content } = buildWelcomePost(user);
      await this.deps.posts.create({ authorId: user.id, title, content }, {}, tx);
      return user; // posts 관계는 커밋 후 Pothos relation loader가 resolve
    });
  }
}
```

- welcome post 생성이 실패하면 `$transaction`이 전체를 롤백 → user도 생성되지 않는다.
- `query` 처리: `register`는 생성된 `user`를 반환하고, `signUp { posts { ... } }` 선택 시 `posts`는 트랜잭션 커밋 후 Pothos가 별도 resolve하므로 welcome post가 응답에 반영된다. **이 동작은 E2E 테스트로 핀**한다. 만약 Pothos가 사전 로드된 빈 관계를 캐시해 welcome post가 누락되면, 트랜잭션 내 마지막에 `query`를 적용해 사용자를 재조회하는 방식으로 보정한다(구현 시 테스트로 결정).

### 5.3 Welcome post 내용 (순수 함수)

```ts
// onboarding.content.ts
import type { User } from '@prisma/client';

export interface WelcomePostContent { title: string; content: string; }

export function buildWelcomePost(user: User): WelcomePostContent {
  const who = user.name ?? 'there';
  return {
    title: 'Welcome!',
    content: `Hi ${who}, welcome aboard. This is your first post — edit or delete it anytime.`,
  };
}
```
onboarding 모듈의 고유 도메인 로직이자 단위 테스트 지점.

### 5.4 GraphQL 표면

```ts
// onboarding.mutation.ts
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

`signUp`은 기존 `UserType`을 반환하므로 새 GraphQL 타입은 없다.

### 5.5 user 모듈 변경 (`user.schema.ts`)

- `createUser` mutationField **제거**.
- `CreateUserInput` Pothos inputType **제거** (GraphQL 표면에서). 단, `user.service.ts`의 TS `CreateUserInput` 인터페이스는 **유지**한다(OAuth `findOrCreateByEmail`과 `OnboardingService.register`가 사용).
- 현재 워킹트리에 남아 있는 미사용 import(`PostService`, `UserService`)와 따옴표/줄바꿈 style churn을 레포 스타일(single-quote)로 정리.

### 5.6 배선 (조립 지점만 수정)

```ts
// context.ts — createServices()
const onboarding = new OnboardingService({ users: user, posts: post, prisma });
return { user, post, auth, onboarding };
```

```ts
// schema.ts — 등록 추가 (user.schema 등은 그대로 import 유지)
import './modules/onboarding/schemas/onboarding.mutation.js';
```

`Services` 타입은 `createServices` 반환형에서 자동 파생되므로 `ctx.services.onboarding`은 추가 타입 작업 없이 잡힌다.

## 6. 데이터 흐름

```
GraphQL signUp(input)
  → onboarding.mutation resolver
    → ctx.services.onboarding.register(input, query)
      → prisma.$transaction(tx =>
          users.create(input, {}, tx)            // User 행 생성
          → buildWelcomePost(user)               // {title, content}
          → posts.create({authorId, ...}, {}, tx) // Post 행 생성 (FK = user.id)
          → return user)                          // 커밋
  → Pothos가 선택된 필드(posts 포함) resolve → 응답
```

## 7. 에러 처리

- welcome post 생성 실패 → 트랜잭션 롤백 → `signUp`이 에러 반환, user 미생성.
- 이메일 검증 실패(`parseEmail`)는 기존과 동일하게 `UserService.create` 경계에서 `DomainError`로 발생 → Yoga `maskedErrors`가 클라이언트에 노출.
- 중복 이메일은 기존과 동일하게 unique 제약 위반으로 처리(트랜잭션이 롤백되므로 welcome post도 생성되지 않음).

## 8. 테스트

- **Step 0 (특성화/스파이크)**: `makeTestPrisma()` 기반으로 `prisma.$transaction` 안에서 의도적으로 throw 시 롤백되는지 확인. **PGlite 어댑터가 interactive transaction을 지원하는지 가장 먼저 판명** (지원 안 하면 §10 폴백).
- **단위** (`src/tests/modules/onboarding/`):
  - `OnboardingService.register`: user + welcome post가 모두 생성되고 post.authorId === user.id, 제목/내용이 `buildWelcomePost`와 일치.
  - 원자성: `posts.create`가 던지도록 스텁/강제하면 트랜잭션 롤백 → `prisma.user.findMany()`가 비어 있음.
  - `buildWelcomePost`: name 유무에 따른 순수 함수 출력.
- **E2E** (`src/tests/e2e/`): `app.inject`로 `signUp` mutation 호출 → user 반환 + `posts`에 welcome post 1건. `createUser`가 스키마에서 제거됐는지(쿼리 시 validation 에러).

## 9. 범위 밖 (의도적)

- OAuth 가입 경로(`findOrCreateByEmail`)는 welcome post 대상이 아니다. 향후 `OnboardingService.registerOrLogin()`으로 확장 가능(최초 생성 분기에서만 welcome post). 이번 범위 아님.
- 기존 `UserService`/`PostService`의 `create` 외 메서드 시그니처 변경 없음.

## 10. 리스크 / 검증 포인트

1. **PGlite interactive transaction 지원** — Step 0 특성화 테스트에서 즉시 판명. 미지원 시 폴백: 트랜잭션 없이 `users.create` 후 `posts.create`를 best-effort(실패 시 로깅)로 전환하고 사용자에게 재확인.
2. **Pothos 관계 재조회 순서** — `signUp { posts }`가 welcome post를 반환하도록 E2E로 핀. 누락 시 트랜잭션 내 재조회(`tx`에 `query` 적용)로 보정.

## 11. 변경 파일 요약

| 파일 | 변경 |
|---|---|
| `src/modules/onboarding/onboarding.service.ts` | 신규 — `OnboardingService.register` |
| `src/modules/onboarding/onboarding.content.ts` | 신규 — `buildWelcomePost` |
| `src/modules/onboarding/schemas/onboarding.mutation.ts` | 신규 — `signUp` mutation |
| `src/modules/user/user.service.ts` | `create`에 `client` 파라미터 추가 |
| `src/modules/post/post.service.ts` | `create`에 `client` 파라미터 추가 |
| `src/modules/user/user.schema.ts` | `createUser`·`CreateUserInput` 제거, import/style 정리 |
| `src/context.ts` | `OnboardingService` 등록 |
| `src/schema.ts` | onboarding mutation 등록 import 추가 |
| `src/tests/modules/onboarding/*` | 신규 — 단위 테스트 |
| `src/tests/e2e/*` | `signUp` E2E (+ `createUser` 제거 확인) |
