# GraphQL Subscriptions · `events/` 레이어 · 전달 사다리 — 설계

- **날짜**: 2026-07-27
- **브랜치**: `feat/graphql-subscriptions` (예정)
- **상태**: 설계 제안, 승인 대기

## 1. 목표

crepe backend가 지원하지만 이 레퍼런스에는 없는 **GraphQL subscription + pub/sub**을 이 저장소의 관용구로 구현한다. crepe 클라이언트가 **와이어 호환**으로 붙을 수 있어야 하고, 신규 클라이언트를 위한 더 단순한 기본 경로도 제시해야 한다.

여기에 **전달 사다리**(at-most-once 직접 발행 ↔ 아웃박스 기반 at-least-once)를 함께 정의한다. 이 사다리의 실증 대상은 crepe의 **IAP(인앱결제)** 파이프라인이다 — 돈이 걸려 있어 이벤트 유실이 허용되지 않고, 현재 구조에 실제 결함이 두 개 있다(§2.3).

부차 목표: crepe가 이 영역에서 겪는 구조적 문제 — 발행 지점 산재, 커밋 보장 없는 발행, 인가 재확인 누락, 이중 쓰기(dual write) — 를 **레이어 규칙과 타입으로** 재발 불가능하게 만든다.

## 2. 배경

### 2.1 crepe 이벤트 버스 현황

| 항목 | 현재 |
|---|---|
| 이벤트 버스 | `backend/src/pubsub.ts` — `createPubSub` + `@graphql-yoga/redis-event-target`, import 시점에 Redis 커넥션 2개 생성 |
| 토픽 | 7개. 전부 `[ownerId, { entityId }]` 형태 — **페이로드가 id 하나뿐** |
| 구독 필드 | 6개 — DM 4 (`schemas/direct-message.ts`), notification·payment·point 각 1. 전부 `authScopes: { user: true }` + `session.userId`/`accountId` 키잉 |
| resolve | 전부 `findUniqueOrThrow` 재조회 |
| 발행 지점 | `utils/direct-message.ts`, **`schemas/direct-message.ts`(리졸버)**, `service/achievement/achievement.util.ts`, **`routes/iamport.ts`·`routes/tosspayments.ts`(라우트)** — 총 15곳 |
| 트랜스포트 | `@fastify/websocket` + `graphql-ws`의 `makeHandler`, `/_/ws`, `connectionParams.accessToken` |
| 클라이언트 | relay + graphql-ws (`frontend/src/lib/relay/subscriber.ts`, `retryAttempts: Infinity`) |
| 알려진 미비 | `main.ts:400` — `// TODO graphql subscription 으로 인한 websocket 처리 보완` (셧다운 시 WS 미드레인) |

### 2.2 레퍼런스 현황

- Subscription 루트 타입 · WS 트랜스포트 · 이벤트 버스 **전부 없음**. README/CONVENTIONS에도 언급 0건.
- `@graphql-yoga/subscription@5.0.5`는 `graphql-yoga@5.21`의 transitive로 **이미 설치돼 있음**. export는 `createPubSub`, `filter`, `map`, `pipe`, `Repeater` — **레이트 계열 연산자는 없음**.
- **principal 없음.** `graphql/context.ts`의 `buildEvalContext` 주석이 명시. `prisma/schema.prisma`에 `Session` 모델 없음.
- rxjs는 이 저장소에도 crepe(backend/frontend/native/packages)에도 **없음**.
- 기존 3분할 선례: `db/{locks,lock-registry,uow}`, `flags/{flags,flag-registry,flag-reader}`, `scheduler/{job,scheduler,agenda}`.
- 기존 사다리 선례: CONVENTIONS §1 "The concurrency ladder" — 0~5 rung, "가장 약한 rung을 고른다".

### 2.3 crepe IAP 파이프라인 현황 (전달 사다리의 실증 대상)

**모델** (`prisma/schema.prisma`)

| 모델 | 역할 |
|---|---|
| `IapNotification` | 웹훅 dedup + 처리 추적. `@@unique([platform, notificationId])`, `status` = PENDING/PROCESSED/DLQ, `retryCount` |
| `IapPurchaseIntent` | 결제 사전 등록. `id` = bindingToken, `consumedAt` write-once 멱등 앵커 |
| `IapPurchase` / `IapGrant` | 검증된 구매 ledger / `PointCharge` 1:1 지급 ledger |

**파이프라인**

```
RTDN webhook (Google Cloud Pub/Sub, at-least-once)
  routes/iap-google.ts
    OIDC 검증 → rate limit → env 확인
    → persistNotification()            [IapNotification create, P2002 → created=false]   ← 커밋 1
    → if (created) agenda.now('iap:google:notification:apply', { notificationDbId })      ← 쓰기 2 (다른 저장소)
    → 204 durable-ack
  tasks/iap-notification-tasks.ts (concurrency 4)
    apply → verify(Google API) → grantGooglePurchase()
    sweep → retryCount>=6 → DLQ; PENDING & <6 & receivedAt<now-60s → 재-enqueue(+retryCount)
  service/iap/grant-google-purchase.ts
    advisory lock 2개(pointKey + iapGooglePurchaseKey) 하의 단일 tx:
      intent.consumedAt write-once → PointCharge → IapPurchase → IapGrant
    → markNotificationProcessed()
```

**결함 F1 — 인제스트의 이중 쓰기.** `persist`가 커밋된 뒤 `agenda.now()`가 별도 저장소에 쓴다. 최초 전달에서 enqueue가 실패하면 503을 반환하고, Google이 재전송하면 persist는 이번엔 `created=false`를 돌려주므로 **`if (persisted.created)` 게이트가 enqueue를 건너뛴다.** 결과적으로 그 알림은 잡이 하나도 걸리지 않은 채 PENDING으로 남고, 오직 60초 sweep만이 구제 경로가 된다(그것도 `retryCount < 6` 예산 안에서).

**결함 F2 — IAP는 아무 이벤트도 발행하지 않는다.** `service/iap`, `routes/iap-*.ts`, `tasks/iap-*.ts`, `api/iap` 전체에 GraphQL `pubsub.publish` 호출이 **0건**이다(해당 디렉터리의 `pubsub` 문자열은 전부 Google Cloud Pub/Sub OIDC 관련). 반면 `routes/iamport.ts`(2곳)와 `routes/tosspayments.ts`(1곳)는 `account:pointCharge`를 발행한다. **같은 포인트 충전인데 결제 수단에 따라 클라이언트 실시간 반영이 갈린다.**

이 두 결함이 사다리의 두 rung을 각각 요구한다: F1은 "쓰기와 후속 작업의 원자성", F2는 "유실되면 안 되는 발행".

## 3. 핵심 설계 결정

| 항목 | 결정 | 근거 |
|---|---|---|
| 디렉터리 | **`src/events/`** — 머신러리 + 레지스트리 + I/O 셸 + 드라이버 | 기존 3분할 선례의 네 번째 |
| fan-out 백엔드 | **Redis 어댑터를 프로덕션 기본**, 기본값 in-memory, 포트로 주입 | 이식 리스크 최소. 포트를 남겨 `LISTEN/NOTIFY` 회귀는 파일 1개 + `server.ts` 1줄 |
| 트랜스포트 | **SSE + graphql-ws 병행** | SSE = 신규 코드 0줄의 기본 경로, graphql-ws = crepe 와이어 호환 |
| 발행 권한 | **서비스만.** 리졸버·라우트·잡·레포·코어 금지 (린트 강제) | crepe의 15개 산재 발행 지점을 choke point 하나로 |
| 발행 시점 | **커밋 이후** | 롤백된 트랜잭션의 이벤트가 구독자를 죽이는 crepe 버그 차단 |
| 구독 접근 | `ctx.events`는 **subscribe 전용 타입** | `ReadDbClient`와 같은 수법 |
| **전달 보장** | **2단 사다리.** rung 0 = 커밋 후 직접 발행(at-most-once, 기본), **rung 1 = 아웃박스(at-least-once)** — 둘 다 이번에 구현 | IAP처럼 돈이 걸린 경로는 유실이 허용되지 않는다. 사다리 형태는 concurrency ladder와 동일한 교리 |
| 아웃박스 싱크 | **버스 발행만.** 잡 enqueue 싱크는 만들지 않는다 | §6.4 — 도메인 테이블이 이미 내구성 큐면 아웃박스를 또 만들지 않는다 |
| 순서 보장 | **없음.** 아웃박스는 순서를 보장하지 않는다 | 동시 드레이너 + `SKIP LOCKED`. 법칙 1(id만)이 순서 무관을 만든다 — §6.3 |
| 인박스 | **패턴으로 문서화, 레퍼런스 코드는 미포함** | 레퍼런스에 at-least-once 인바운드 표면이 없다. crepe `IapNotification`이 이미 올바른 구현체 |
| 스트림 연산 | **순수 정책(`rate.ts`) + 셸(`operators.ts`)**, Rx 미도입 | 정책이 순수해져 프로퍼티 테스트 대상이 됨 |
| principal | **실물 `Session` 모델 + 최소 seam** | crepe가 DB row 조회 한 방. 포트+stub은 가짜 추상화 |
| 대표 구독 | **`pointBalanceChanged`** 1개 | 4개 유스케이스에서 발행 → 법칙이 모듈 전체에 적용되는 게 보이고, throttle과 아웃박스 양쪽에 진짜 호출 지점이 생김 |

### 3.1 왜 Rx가 아닌가

Rx가 이기는 지점은 실재한다(crepe `directMessageRoomMeta`의 `action: 'typing'`은 교과서적 throttle 케이스이고, Yoga는 `filter`/`map`만 준다). 그럼에도 도입하지 않는 이유:

1. **GraphQL 경계가 AsyncIterable을 요구한다.** graphql-js `subscribe()`와 Pothos `t.field({ subscribe })`가 AsyncIterable을 받으므로 Rx는 경계에서 반드시 변환되고, 사는 구간은 `event-bus.ts` 내부뿐이다.
2. **백프레셔가 정반대다.** Observable은 push 기반이라 백프레셔가 없고, Repeater는 pull 기반이라 소비자가 `next()`를 부를 때까지 생산자가 대기한다. 실제 소비자가 모바일 네트워크 위 WebSocket이므로 취향이 아니라 실패 모드의 차이다.
3. **정책을 순수 함수로 쓰면 프로퍼티 테스트가 붙는다.** Rx 연산자를 쓰면 그 로직이 라이브러리 안에 있어 이 저장소가 가장 잘하는 일을 할 수 없다.
4. **비용이 비대칭이다.** 두 저장소 모두 Rx 자산 0. 두 번째 비동기 패러다임 + 세 번째 테스트 패러다임(marble)이 들어온다.

**재검토 트리거**: ① 한 구독이 3개 이상 토픽을 시간축으로 조인 ② 직접 쓴 연산자가 5개 초과 ③ 윈도잉 집계 필요. 계약이 AsyncIterable이므로 그때도 비용은 `event-bus.ts` 한 파일이다.

### 3.2 구현 순서 — 세 단계로 나눈다

서로 독립적으로 검증 가능한 세 덩어리이고 뒤가 앞에 의존한다. 구현 계획을 나누어 각 단계 끝에서 전체 테스트가 초록인 상태를 만든다.

| 단계 | 범위 | 이 단계만으로 검증되는 것 |
|---|---|---|
| **A. principal seam** | §10 전체 + §9.3(async 팩토리) + §9.4(`requirePrincipal`) + `UnauthenticatedError` | `parseCredential` 프로퍼티, 만료 세션 거부, OAuth 콜백의 세션 mint, 기존 e2e 무회귀 |
| **B. events + subscriptions** | §4.1~4.2, §5, §6.1(rung 0), §7~§9.2, §11~§12 | 발행 법칙, 연산자 법칙, 양쪽 트랜스포트 e2e |
| **C. 아웃박스 (rung 1)** | §4.3, §6.2~§6.4 | 트랜잭션 원자성, 크래시 후 재개, 중복 전달 무해성, 순서 무관성 |

A를 먼저 끝내는 이유는 B의 대표 구독이 `requirePrincipal`에 의존하고, A가 **컨텍스트 팩토리를 async로 바꾸는 광범위한 변경**(§19-5)이라 구독 작업과 섞이면 회귀 원인 분리가 어렵기 때문이다. C는 B의 `events.publish`를 대체하지 않고 **옆에 rung을 하나 더 놓는** 작업이라 마지막이 자연스럽다.

## 4. 아키텍처

```
src/events/
  events.ts             # 순수 머신러리: TopicSpec, topic(), defineTopics(),
                        #   EventPublisher/EventSubscriber/EventBus 타입. import 없음
  event-registry.ts     # WHAT: TOPICS — 토픽 이름·키 종류·페이로드 타입·JSDoc (순수)
  rate.ts               # 순수 정책: planEmit(state, now, minIntervalMs) → EmitDecision
  operators.ts          # 셸: throttle() — async generator, 주입된 Clock을 읽음
  event-bus.ts          # uow.ts / flag-reader.ts 아날로그: TOPICS를 Yoga createPubSub에
                        #   바인딩하고 subscribe 옵션에 따라 연산자를 적용하는 I/O 셸
  outbox.repo.ts        # Prisma: 같은 tx 삽입 / SKIP LOCKED 클레임 / 발행·실패 표시 / 퍼지
  outbox.ts             # 드레이너 셸: 클레임 → publish → 표시. notify() 웨이크업
  outbox.job.ts         # 스케줄 delivery: events:outbox:drain / events:outbox:purge
  redis-event-target.ts # scheduler/agenda.ts 아날로그(드라이버): ioredis 2 커넥션 →
                        #   TypedEventTarget. server.ts가 REDIS_URL 유무로 결정
```

**순수 파일은 `events.ts`, `event-registry.ts`, `rate.ts` 셋**이며 이들은 I/O를 import하지 않는다(`flags.ts`/`flag-registry.ts`와 같은 취급). 나머지는 셸이다 — `uow.ts`가 prisma를, `flag-reader.ts`가 SDK를, `agenda.ts`가 pg 백엔드를 import하는 것과 같다.

`events/`는 **어떤 모듈도 import하지 않는다**(`builder.ts`와 같은 제약). 페이로드 타입은 구조적으로 적어 두고 모듈 타입을 끌어오지 않는다.

신규 의존성 4개: `ioredis`, `graphql-ws`, `@fastify/websocket`, `@graphql-yoga/redis-event-target`. `createPubSub`은 이미 설치돼 있다.

> Redis `EventTarget`은 손으로 구현하지 않고 공식 어댑터(`@graphql-yoga/redis-event-target`)를 쓴다 — crepe와 같은 구현체라 이식 리스크가 낮다. **버전은 `^3.0.3`이어야 한다**: crepe가 쓰는 `1.0.0`은 `@graphql-yoga/typed-event-target@^1`에 의존하는데 yoga 5.21의 `@graphql-yoga/subscription@5.0.5`는 `^3.0.2`를 쓰므로, 1.x 타깃을 `createPubSub`에 넘기면 `TypedEventTarget` 타입이 어긋난다. crepe도 같은 조합이라 이식 시 함께 올려야 한다.

### 4.1 머신러리 (`events.ts`)

```ts
/**
 * 토픽의 키 종류. 아웃박스가 키를 TEXT로 저장했다가 되읽을 때 필요한 코덱 태그다.
 * 조건부 타입이라 `topic<number, …>('string')` 은 컴파일 에러 — 드리프트가 불가능하다.
 */
export type KeyKind = 'string' | 'number';

export interface TopicSpec<TKey extends string | number, TPayload> {
  readonly keyKind: KeyKind;
  readonly __key?: TKey;        // 타입 전용 phantom
  readonly __payload?: TPayload;
}

export function topic<TKey extends string | number, TPayload>(
  keyKind: TKey extends number ? 'number' : 'string',
): TopicSpec<TKey, TPayload>;

export type Topics = Record<string, TopicSpec<string | number, unknown>>;
export function defineTopics<T extends Topics>(topics: T): T;

export type TopicKey<S> = S extends TopicSpec<infer K, unknown> ? K : never;
export type TopicPayload<S> = S extends TopicSpec<string | number, infer P> ? P : never;

/** subscribe 시점의 선언적 설정. 스키마 레이어가 넘기는 유일한 스트림 제어 수단. */
export interface SubscribeOptions {
  /**
   * 이 구독의 최소 방출 간격(ms). 억제되는 동안 가장 최근 이벤트만 남기고 나머지는
   * 버린다 — 페이로드가 id뿐이고 resolve가 재조회하므로 무손실이다(법칙 1).
   * 0 또는 미지정이면 연산자가 붙지 않는다.
   */
  minIntervalMs?: number;
}

export interface EventPublisher<T extends Topics> {
  /** rung 0: 즉시 발행(at-most-once). 반드시 커밋 이후에 호출한다(법칙 4). */
  publish<K extends keyof T & string>(
    topic: K, key: TopicKey<T[K]>, payload: TopicPayload<T[K]>,
  ): void;
}

export interface EventSubscriber<T extends Topics> {
  subscribe<K extends keyof T & string>(
    topic: K, key: TopicKey<T[K]>, options?: SubscribeOptions,
  ): AsyncIterable<TopicPayload<T[K]>>;
}

export type EventBus<T extends Topics> = EventPublisher<T> & EventSubscriber<T>;
```

### 4.2 레지스트리 (`event-registry.ts`)

```ts
import {
  defineTopics, topic, type EventPublisher, type EventSubscriber,
} from './events.js';

/** 발행되는 것이 무엇인지 말하는 유일한 파일. 토픽을 추가하는 곳은 여기뿐이다. */
export const TOPICS = defineTopics({
  /**
   * 사용자의 포인트 잔액이 변경됨. charge / spend / transfer / expire 가 발행한다.
   * 키 = userId. 페이로드에 잔액 값을 싣지 않는다 — 구독자가 재조회한다(법칙 1).
   */
  pointBalanceChanged: topic<number, { userId: number }>('number'),
});

export type AppTopics = typeof TOPICS;
export type AppEventPublisher = EventPublisher<AppTopics>;
export type AppEventSubscriber = EventSubscriber<AppTopics>;
```

### 4.3 아웃박스 모델

```prisma
/// 트랜잭션 아웃박스 — 도메인 쓰기와 같은 트랜잭션에 삽입되고, 커밋 후 드레이너가
/// 버스로 발행한다(전달 사다리 rung 1). 페이로드는 법칙 1에 따라 id만 담으므로
/// 스키마 진화에 강하고, 중복·순서뒤바뀜이 무해하다.
model OutboxEvent {
  id          BigInt    @id @default(autoincrement())
  topic       String
  /// 토픽 키를 TEXT로 정규화한 값. 되읽을 때 TopicSpec.keyKind 로 파싱한다.
  key         String
  payload     Json
  createdAt   DateTime  @default(now()) @db.Timestamptz(6)
  publishedAt DateTime? @db.Timestamptz(6)
  attempts    Int       @default(0)
  /// 재시도 소진(DLQ). 클레임 대상에서 제외되고 운영자 개입을 기다린다.
  failedAt    DateTime? @db.Timestamptz(6)
}
```

마이그레이션은 손으로 쓴 SQL이므로(CONVENTIONS §7) **부분 인덱스**를 쓴다 — 테이블이 커져도 클레임 스캔이 대기열 크기에만 비례한다:

```sql
CREATE INDEX "OutboxEvent_pending_idx" ON "OutboxEvent" ("id")
  WHERE "publishedAt" IS NULL AND "failedAt" IS NULL;
ALTER TABLE "OutboxEvent" ADD CONSTRAINT "OutboxEvent_attempts_check" CHECK ("attempts" >= 0);
```

`publishedAt`·`failedAt`은 결정에 쓰이는 타임스탬프이므로 **앱 클럭으로 스탬프**한다(CONVENTIONS §10 규칙 1). `createdAt`은 감사용이며 어떤 결정도 읽지 않는다.

## 5. 다섯 가지 법칙

CONVENTIONS §11로 문서화한다.

### 법칙 1 — 페이로드는 id만 싣는다

row를 싣지 않는다. 근거 넷:

1. `resolve`가 Pothos `query`로 재조회하므로 구독자의 selection set이 그대로 서빙된다 — CONVENTIONS §2의 "뮤테이션 후 re-fetch"와 **같은 규칙**이다.
2. 페이로드는 프로세스 경계와 네트워크를 건넌다. row는 도착 시점에 이미 낡았고, 구독자가 읽지 않을 컬럼까지 밖으로 나간다.
3. 페이로드가 작아야 fan-out 백엔드를 자유롭게 교체할 수 있다(예: Postgres `NOTIFY`의 8000바이트 한도).
4. **아웃박스의 세 가지 성질이 전부 여기서 나온다** — 중복 전달 무해, 순서 무관, 스키마 진화 내성. §6.3 참조.

### 법칙 2 — 토픽 키로 라우팅한다. 구독 필드에서 filter하지 않는다

`pipe(subscribe(...), filter(...))`로 거르면 모든 인스턴스가 모든 이벤트를 받는다. 필터링은 키잉으로 해결한다.

### 법칙 3 — 발행은 유스케이스의 효과다. 서비스만 발행한다

| 레이어 | publish / outbox.enqueue | 근거 |
|---|---|---|
| core | ✗ | 순수 |
| repo | ✗ | row가 왜 바뀌었는지 모른다 |
| schema / route / job | ✗ | 전부 delivery. 이미 "결정과 쓰기는 서비스에 위임"이 규칙 |
| service | ✓ | 모든 호출자가 지나가는 choke point |

버스와 아웃박스 모두 long-lived 싱글턴이므로 `ctx.flags`처럼 요청마다 오는 게 아니라 `clock`처럼 `createServices()`에서 주입된다.

### 법칙 4 — 발행은 커밋 이후의 효과다. rung은 가장 약한 것을 고른다

전달 사다리(§6). rung 0의 코드 형태:

```ts
const charge = await uow.run(db, (tx) => pointRepo.applyChargePlan(tx, userId, plan)); // commit
events.publish('pointBalanceChanged', userId, { userId });                             // after commit
```

`uow` 안에서 발행하고 트랜잭션이 롤백되면 구독자는 존재하지 않는 row의 이벤트를 받고 `findUniqueOrThrow`가 던진다. graphql-ws에서 에러는 구독을 **종료**시키고 relay 클라이언트는 무한 재시도한다. crepe의 실제 결함이다.

### 법칙 5 — 재조회의 `where`가 인가 경계다. 소유권은 언제나 principal에서 온다

토픽 키만으로는 인가가 아니다. 잘못된 키로 발행하는 코드 버그 하나가 곧 데이터 유출이다. crepe는 `notificationStream`만 이걸 하고 DM·payment·point 스트림 4개는 `where: { id }`뿐이다.

정확히는 `where`의 두 부분이 **서로 다른 출처**를 가져야 한다:

| `where` 부분 | 출처 | 역할 |
|---|---|---|
| "누구 것인가" | **항상 `requirePrincipal(ctx)`** | 인가 |
| "어떤 row인가" | payload의 id | 좁히기 |

payload는 어떤 row를 볼 수 있는지 **결정하지 못한다**. `PointBalance`처럼 audience와 소유자가 같고 `userId`가 PK인 경우 payload는 조회에 전혀 기여하지 않는 순수 트리거다:

```ts
where: { userId: requirePrincipal(ctx).userId }
```

entity ≠ audience인 토픽(crepe의 `directMessageStream` — 수신자가 구독하고 payload는 `directMessageId`)에서는 두 부분이 모두 나타난다:

```ts
where: { id: payload.directMessageId, receiverId: requirePrincipal(ctx).userId }
```

## 6. 전달 사다리

concurrency ladder(CONVENTIONS §1)와 같은 교리다 — **불변식을 지키는 가장 약한 rung을 고른다.** 위 rung은 더 비싸고 더 많이 숨긴다.

| rung | 수단 | 보장 | 산다 | 고르는 기준 |
|---|---|---|---|---|
| 0 | 커밋 후 `events.publish` | at-most-once | service | 유실이 UX 저하에 그친다 (기본) |
| 1 | 아웃박스: 같은 tx에 삽입 → 드레이너가 발행 | at-least-once | service + `events/outbox*` | 유실이 돈·정합성 문제다 |

인바운드 쪽의 대응물은 **인박스**(§6.5)로, 사다리가 아니라 외부 at-least-once 소스를 받을 때의 필수 패턴이다.

### 6.1 rung 0 — 커밋 후 직접 발행 (기본)

§5 법칙 4의 코드 형태. 크래시가 커밋과 publish 사이에 끼면 이벤트는 유실된다. **이걸 수용하는 근거는 "구독은 캐시 무효화 힌트이지 유일한 전달 경로가 아니다"** 이다 — 재연결 시 클라이언트의 재조회가 정상 복구 경로다. 대부분의 토픽은 여기 머문다.

### 6.2 rung 1 — 아웃박스

```ts
async charge(userId: number, input: ChargePointInput): Promise<PointCharge> {
  const plan = planCharge(input, clock.now());                       // decide
  const charge = await uow.run(db, async (tx) => {
    const created = await pointRepo.applyChargePlan(tx, userId, plan);
    await outbox.enqueue(tx, 'pointBalanceChanged', userId, { userId }); // ← 같은 트랜잭션
    return created;
  });
  outbox.notify();  // 커밋 후 드레이너 웨이크업. 실패해도 무해 — 스케줄 드레인이 권위다.
  return charge;
}
```

rung 0과의 차이는 두 줄뿐이고, 형태가 같아서 **한 토픽을 rung 0 ↔ 1 사이에서 옮기는 것이 호출자에게 보이지 않는다** — concurrency ladder가 `uow.serialized` ↔ `uow.snapshot` 교체를 호출자에게 숨기는 것과 같은 성질이다.

**드레이너** (`outbox.ts`)

```ts
export interface Outbox<T extends Topics> {
  /** 도메인 쓰기와 같은 트랜잭션에서 호출한다. tx를 받는 것이 계약의 핵심이다. */
  enqueue<K extends keyof T & string>(
    tx: DbClient, topic: K, key: TopicKey<T[K]>, payload: TopicPayload<T[K]>,
  ): Promise<void>;
  /** 커밋 후 드레이너를 깨운다. 멱등하고 실패해도 무해하다. */
  notify(): void;
  /** 한 배치를 클레임해 발행한다. 반환값은 발행 건수. */
  drain(): Promise<number>;
}
```

클레임은 concurrency ladder **rung 4**(`FOR UPDATE SKIP LOCKED` — "claim specific rows (e.g. a worker queue)")이고, CONVENTIONS가 그 rung은 repo에 산다고 못박았으므로 `outbox.repo.ts`에 둔다:

```sql
SELECT "id", "topic", "key", "payload" FROM "OutboxEvent"
WHERE "publishedAt" IS NULL AND "failedAt" IS NULL
ORDER BY "id"
FOR UPDATE SKIP LOCKED
LIMIT $1
```

**두 속도로 돈다.** 즉시성은 `notify()`(커밋 직후 인프로세스 웨이크업, 밀리초)가 담당하고, 정확성은 스케줄 잡 `events:outbox:drain`(30초)이 담당한다 — 크래시로 `notify()`를 놓쳤거나 다른 인스턴스가 넣은 row를 반드시 잡는다. **`notify()`는 최적화이지 정확성 요건이 아니다.**

**포이즌 row**: `attempts`가 상한(10)에 닿으면 `failedAt`을 스탬프해 클레임 대상에서 빼고 로그로 표면화한다. crepe의 `retryCount >= 6 → DLQ`와 같은 형태이며, 한 개의 나쁜 row가 큐를 막지 않게 한다.

**보존**: 발행된 row는 `events:outbox:purge`(일 1회)가 정리한다 — 이미 있는 `feature-flag:purge-deleted`와 같은 모양.

### 6.3 아웃박스가 포기하는 것 — 순서

동시 드레이너 + `SKIP LOCKED`는 **전역 순서를 보장하지 않는다.** 같은 키의 두 이벤트가 뒤바뀌어 도착할 수 있다.

**이게 허용되는 이유는 오직 법칙 1 때문이다.** 페이로드가 id뿐이고 `resolve`가 현재 상태를 재조회하므로, 두 이벤트가 어떤 순서로 오든 구독자는 같은 최신 상태를 본다. 같은 이유로 **중복 전달도 무해하다** — at-least-once의 대가인 dedup이 구독 싱크에는 아예 필요 없다.

순서가 실제로 필요한 토픽이 생기면 그건 다른 메커니즘(키 단위 직렬화)이고, 이 아웃박스는 그 답이 아니다. 문서에 명시한다.

### 6.4 아웃박스를 만들지 않는 경우 — 도메인 테이블이 이미 큐일 때

**규칙: 도메인 테이블이 이미 내구성 있는 작업 큐면 아웃박스를 또 만들지 않는다.**

crepe IAP가 정확히 이 경우다. `IapNotification`의 `status = PENDING` row는 인제스트 트랜잭션에서 커밋되는 순간 이미 **내구성 있는 작업 항목**이다. `agenda.now()`는 지연을 줄이는 힌트일 뿐이고, sweep이 권위 있는 재개 경로다. 여기에 아웃박스를 얹으면 같은 의미의 큐가 둘이 된다.

그래서 이 설계의 아웃박스는 **싱크가 버스 발행 하나뿐**이다. 잡 enqueue 싱크는 만들지 않는다 — 필요해 보이면 대개 도메인 테이블이 이미 큐인 경우다.

F1(§2.3)이 아웃박스 없이도 고쳐지는 이유가 이것이다: enqueue를 `created` 게이트 밖으로 꺼내면 재전송마다 웨이크업이 다시 걸리고, 큐 자체는 이미 트랜잭션 안에 있었다.

### 6.5 인박스 — 외부 at-least-once를 받는 쪽

아웃박스의 거울상. 외부(Apple/Google/PG사)에서 오는 알림은 **중복·순서뒤바뀜·지연이 기본값**이므로 수신 측이 멱등해야 한다.

| 규칙 | 내용 | crepe 준수 |
|---|---|---|
| I1 | dedup 키는 `(source, externalId)` **unique 제약** | ✓ `@@unique([platform, notificationId])` |
| I2 | **create 먼저, P2002를 재전송으로 판정.** `findUnique` 후 `create`는 동시 요청에서 둘 다 신규로 판정되는 race | ✓ `createPersistIapNotification`이 정확히 이 형태 |
| I3 | 인박스 row가 **곧 작업 큐**. 상태 전이 PENDING → PROCESSED \| DLQ | ✓ |
| I4 | 웨이크업(enqueue)은 **정확성 요건이 아니다.** sweep이 권위 | ✗ **F1** — `created` 게이트가 재전송 시 웨이크업을 막는다 |
| I5 | 터미널 전이는 멱등 | ✓ `markNotificationProcessed` |

레퍼런스에는 at-least-once 인바운드 표면이 없으므로(유일한 비-GraphQL 표면인 OAuth 콜백은 해당 없음) **인박스는 코드가 아니라 규칙으로 싣는다.** crepe `IapNotification`이 I1·I2·I3·I5를 이미 만족하는 참조 구현이고, 고칠 것은 I4 하나다.

## 7. 구독 측

```ts
// src/modules/point/schemas/point.subscription.ts  (query/mutation의 peer)
import { builder } from '../../../graphql/builder.js';
import { requirePrincipal } from '../../../graphql/context.js';

export function registerPointSubscriptions() {
  builder.subscriptionFields((t) => ({
    pointBalanceChanged: t.prismaField({
      description: '구독자 본인의 포인트 잔액 변경 스트림.',
      type: 'PointBalance',
      subscribe: (_root, _args, ctx) =>
        ctx.events.subscribe(
          'pointBalanceChanged',
          requirePrincipal(ctx).userId,
          { minIntervalMs: 1000 },
        ),
      resolve: (query, _payload, _args, ctx) =>
        ctx.db.pointBalance.findUniqueOrThrow({
          ...query,
          // 법칙 5: 소유권은 payload가 아니라 principal에서 온다. PointBalance는
          // userId가 PK이고 audience == 소유자이므로 payload는 순수한 트리거다.
          where: { userId: requirePrincipal(ctx).userId },
        }),
    }),
  }));
}
```

`registerPointSubscriptions()`는 `point/schemas/index.ts`의 `registerPointModule()`에서 호출된다.

**`ctx.events`는 `AppEventSubscriber` 타입이므로 `publish`가 없다.** "리졸버는 발행할 수 없다"가 규약이 아니라 컴파일 타임 사실이다.

**raw `pipe` 탈출구는 두지 않는다.** 모든 연산자 조합은 `event-bus.ts`에서 `SubscribeOptions`를 통해 일어난다. 스키마 레이어는 레이트를 **선언**할 뿐 조립하지 않는다 — CONVENTIONS §2가 `t.relationCount`의 필터에 쓴 표현 그대로 "declarative plugin config"다.

## 8. 스트림 연산자

### 8.1 무엇이 연산자가 되어야 하는가

| 관심사 | 어디 있어야 하나 |
|---|---|
| "이 이벤트는 애초에 보낼 가치가 없다" | **서비스/코어.** 발행 자체를 안 한다 |
| "이 구독자에겐 이 종류만" | **토픽 키** (법칙 2) |
| "이 구독자가 볼 수 있는 row인가" | **재조회의 `where`** (법칙 5) |
| **"초당 50번은 이 클라이언트가 감당 못 한다"** | **연산자** ← 유일하게 여기여야 하는 것 |

레이트는 이벤트의 성질이 아니라 **구독자의 내성**이다. 발행자는 구독자가 몇 명인지, 각자 얼마나 빨리 소비하는지 모르므로 publish 지점으로 밀어낼 수 없다. `filter`/`distinct`를 연산자로 만들고 싶어지면 대개 발행을 잘못 설계한 신호다.

### 8.2 순수 정책 (`rate.ts`)

`.oxlintrc.json`이 `Date` 전역을 값으로 금지하고 CONVENTIONS §1이 "`await` never appears in a core file"이므로, 시계를 읽고 await하는 연산자는 그대로 두면 규칙 위반이다. `locks.ts` ↔ `uow.ts`와 같은 분할로 정책만 순수하게 뽑는다.

```ts
export interface ThrottleState { readonly lastEmittedAt: Date | null }
export type EmitDecision =
  | { readonly kind: 'emit'; readonly next: ThrottleState }
  | { readonly kind: 'defer'; readonly waitMs: number };

export const initialThrottleState: ThrottleState;

/** 전 함수. now는 파라미터로 들어온다(CONVENTIONS §10) — 시계를 읽지 않는다. */
export function planEmit(
  state: ThrottleState, now: Date, minIntervalMs: number,
): EmitDecision;
```

**프로퍼티 (`rate.prop.test.ts`)**

| 법칙 | 내용 |
|---|---|
| 레이트 상한 | 임의의 시퀀스에서 `emit`이 난 두 시각의 차는 항상 `minIntervalMs` 이상 |
| 전 함수 | 임의의 `(state, now, minIntervalMs ≥ 0)`에 대해 `emit` 또는 `defer`를 반환하고 throw하지 않는다 |
| identity | 이벤트 간격이 항상 `minIntervalMs` 이상이면 모든 이벤트가 `emit` |
| 대기 정합 | `defer`의 `waitMs`만큼 지난 뒤 같은 상태로 다시 물으면 반드시 `emit` |
| 비활성 | `minIntervalMs === 0`이면 항상 `emit` (연산자 미적용과 동일 경로) |

### 8.3 셸 (`operators.ts`)

```ts
export function throttle<T>(
  minIntervalMs: number, clock: Clock,
): (source: AsyncIterable<T>) => AsyncIterable<T>;
```

의미: **간격당 최대 1회 방출. 억제 중에는 가장 최근 이벤트만 유지. 마지막 이벤트는 반드시 방출(trailing edge).** 억제 중 이전 이벤트를 버려도 되는 이유는 법칙 1 때문이다.

셸의 성질(trailing edge 보장, 취소 시 upstream `return()` 전파)은 프로퍼티가 아니라 **명시적 테스트**로 잡는다.

## 9. 컨텍스트 · 라우팅 변경 (`graphql/context.ts`)

### 9.1 `'subscription'` 오퍼레이션 종류 추가 → `rw` 라우팅

현재 `classifyOperation`은 subscription을 `'other'`로 분류하고 `routeClient`가 `'other'`를 `rw`로 보낸다. 결과는 맞지만 "분류 실패 시 안전빵"이라는 뜻이라 의도가 기록되지 않는다. 명시적 종류를 추가하고 **`rw`로 라우팅**한다.

> 이벤트는 프라이머리의 커밋 **이후에** 인과적으로 발생한다. 그 시점에 리플리카는 아직 그 row를 못 봤을 수 있고 `findUniqueOrThrow`는 그냥 던진다. 구독의 재조회는 평범한 읽기처럼 보이지만 replica lag을 건너는 읽기다.

아웃박스 경유(rung 1)는 드레인 지연이 더해져 이 위험이 **줄어들지만 사라지지는 않는다** — 지연은 보장이 아니다. 라우팅 규칙은 두 rung에 동일하게 적용한다.

`writer(ctx)`는 `'subscription'`도 계속 거부한다(뮤테이션 전용 유지).

### 9.2 구독의 컨텍스트 수명 — 문서화 필요

컨텍스트는 subscribe 시점에 **한 번** 만들어져 스트림 전체를 산다.

- **`ctx.flags`는 요청 단위 메모이즈이므로 연결이 살아있는 내내 플래그 값이 고정된다.** 킬 스위치는 *새* 구독에만 걸린다. 이벤트마다 살아있는 값이 필요하면 `resolve` 안에서 다시 읽어야 한다.
- `ctx.logger`의 `reqId`가 몇 시간짜리가 된다(수용, 기록만).
- OTel span 수명은 §19 검증 항목.

### 9.3 컨텍스트 팩토리가 async가 된다

세션 조회가 DB 읽기이므로 `createContextFactory`의 반환 함수가 `Context`에서 `Promise<Context>`로 바뀐다. Yoga는 async 컨텍스트 팩토리를 지원한다. 자격증명이 **있을 때만** 조회하므로 미인증 요청에는 추가 왕복이 없다.

### 9.4 `requirePrincipal(ctx)`

`writer(ctx)` 바로 옆, 같은 파일에 둔다 — 형태가 같다(런타임 가드 + 못 하면 throw).

```ts
/** 인증된 principal을 요구한다. 없으면 UnauthenticatedError(UNAUTHENTICATED). */
export function requirePrincipal(ctx: Context): Principal;
```

crepe의 `session!` non-null assertion 15개가 사라진다.

## 10. principal seam

### 10.1 `Session` 모델

```prisma
model Session {
  id          String   @id @default(uuid())
  accessToken String   @unique
  userId      Int
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  createdAt   DateTime @default(now()) @db.Timestamptz(6)
  expiresAt   DateTime @db.Timestamptz(6)
}
```

`expiresAt`은 결정에 쓰이는 타임스탬프이므로 **앱 클럭으로 스탬프**한다(CONVENTIONS §10 규칙 1). `createdAt`은 감사용이며 어떤 결정도 읽지 않는다(CONVENTIONS §10 규칙 2).

### 10.2 순수 자격증명 파서 (`modules/auth/auth.value.ts`)

```ts
export type Credential = string & { readonly [brand]: 'Credential' };

export interface CredentialSource {
  cookies?: Record<string, string | undefined>;
  authorization?: string;
  /** graphql-ws 레거시 경로. 아래 우선순위 주석 참고. */
  connectionParams?: Record<string, unknown>;
}

export function parseCredential(source: CredentialSource): Credential | null;
```

우선순위: **쿠키 → `Authorization: Bearer` → `connectionParams.accessToken`**. crepe는 `connectionParams`를 먼저 보지만 코드 주석이 "it leaks access token to the client which can lead to XSS attack"라며 폐기 의사를 밝히고 있다. WS 업그레이드 요청에서도 쿠키를 읽을 수 있으므로 `connectionParams`는 **문서화된 폐기 예정 호환 경로**로 마지막에 둔다.

**HTTP와 WS가 같은 파서를 쓴다.** crepe `createContext`의 if/else 사슬이 프로퍼티 테스트 가능한 전 함수 하나로 대체된다.

### 10.3 나머지 배선

- `auth.repo.findSessionByToken(db, token)` — 프로젝션
- `auth.service.resolvePrincipal(credential, now)` — 만료는 주입 클럭 기준(CONVENTIONS §10 "두 개의 시계")
- `oauth.service`가 콜백 성공 시 세션을 mint하고 쿠키를 세팅
- `graphql/context.ts`에 `principal?: Principal`. 덤으로 `buildEvalContext`의 `targetingKey` TODO가 닫힌다
- `foundation/errors.ts`에 `UnauthenticatedError`(코드 `UNAUTHENTICATED`)

**범위가 함께 커지는 지점**: 아무도 세션을 발급하지 않으면 아무도 구독할 수 없으므로 OAuth 콜백의 세션 mint까지 포함해야 한다.

## 11. 트랜스포트

### 11.1 SSE — 신규 코드 0줄

Yoga는 기존 `/graphql` 엔드포인트에서 `Accept: text/event-stream`으로 구독을 서빙하고, `app.ts`의 라우트는 이미 `handleNodeRequestAndResponse`를 쓴다. (실제 스트리밍 동작은 §19-1 검증 항목.)

### 11.2 graphql-ws — 호환 경로

`@fastify/websocket` + `makeHandler`를 **`/graphql/ws`**에 마운트한다. `onSubscribe`는 crepe와 동일하게 `yoga.getEnveloped()`를 거쳐야 오퍼레이션 로그·OTel·컨텍스트 팩토리가 HTTP와 동일하게 돈다.

crepe 클라이언트 변경은 **`VITE_API_PUBLIC_WS_URL` 한 줄**이다(`/_/ws` → `/graphql/ws`). 프로토콜 동일.

### 11.3 Graceful shutdown — crepe의 `main.ts:400` TODO를 닫는다

`server.ts`의 SIGTERM 순서:

1. `scheduler.stop()` — 인플라이트 잡 드레인
2. **아웃박스 최종 드레인 1회** — 커밋됐지만 아직 발행 안 된 row를 넘기고 내려간다(실패해도 다음 인스턴스가 집는다)
3. **WS 신규 수락 중단 + 살아있는 구독에 close(1001) 전송**
4. `app.close()`
5. eventTarget(Redis) 종료 — `ownsEventTarget`일 때만
6. `shutdownTelemetry()`
7. `Sentry.close(2000)`

1001은 클라이언트에게 "정상 종료, 다른 인스턴스로 재연결하라"는 신호라 relay의 무한 재시도와 맞물려 무중단 배포가 된다.

### 11.4 컴포지션 루트 변경

`buildApp({ eventTarget })`을 추가한다. 기본값은 in-memory이므로 **테스트는 Redis를 절대 건드리지 않는다.** `ownsDb`와 같은 방식으로 `ownsEventTarget`을 두어, 주입받은 타깃은 주입자가 닫는다. 아웃박스 드레인 잡은 `buildScheduler()`에 등록된다 — 스케줄러가 꺼진 프로세스(`SCHEDULER_ENABLED=false`)는 `notify()` 경로로만 드레인하므로, **최소 한 프로세스는 스케줄러를 켜 두어야 한다**는 운영 조건을 README에 적는다.

## 12. 레이어 강제

### 12.1 oxlint (`no-restricted-imports`)

flags facade와 정확히 동형이다. `**/events*`가 `event-bus`/`event-registry`를 매치하지 **않으므로** 글롭을 나눠 적는다(CONVENTIONS §9가 flags에서 같은 함정을 이미 기록).

| 레이어 | 금지 |
|---|---|
| core | `**/events*`, `**/event-registry*`, `**/event-bus*`, `**/outbox*`, `**/operators*`, `**/rate*` |
| repo | 동일 |
| service | `**/event-bus*`, `**/operators*`, `**/rate*` — `events`/`event-registry`/`outbox`의 **타입**은 허용 (`FlagReader` 타입과 같은 취급) |
| schema | `**/event-bus*`, `**/outbox*`, `**/operators*`, `**/rate*` — `ctx.events`로만 접근 |
| route / job | 동일 |

`events/outbox.repo.ts`와 `events/outbox.job.ts`는 기존 레이어 글롭(`src/**/modules/**/*.repo.ts`, `src/**/modules/**/jobs/**`)에 걸리지 않으므로 각 항목의 `files`에 명시적으로 추가한다.

### 12.2 dependency-cruiser

`builder.ts`와 같은 제약을 건다: **`src/events/`는 `src/modules/`를 import할 수 없다.** 페이로드 타입은 구조적으로 적어 `events/`를 leaf로 유지한다.

## 13. 데이터 흐름

```
mutation chargePoint                                              [rung 1 — 아웃박스]
  → point.mutation resolver → ctx.services.point.charge(...)
      → uow.run(db, tx => { applyChargePlan(tx, …)
                            outbox.enqueue(tx, 'pointBalanceChanged', userId, {userId}) })  // 커밋
      → outbox.notify()                                          // 웨이크업 (최적화)
  → 드레이너: SKIP LOCKED 클레임 → bus.publish → publishedAt 스탬프
      → eventTarget (in-memory | Redis) → 전 인스턴스 fan-out

mutation spendPoint                                               [rung 0 — 직접]
  → ... → uow.snapshot(...)  // 커밋
      → events.publish('pointBalanceChanged', userId, { userId })

subscription pointBalanceChanged            (SSE /graphql | WS /graphql/ws)
  → contextFactory: parseCredential → resolvePrincipal → ctx.principal, ctx.db = rw (§9.1)
  → subscribe: ctx.events.subscribe(topic, principal.userId, { minIntervalMs: 1000 })
      → throttle(1000, clock)               // 셸이 planEmit(순수)로 결정
  → 이벤트마다 resolve: findUniqueOrThrow({ ...query, where: { userId: principal.userId } })  // 법칙 5
  → Pothos가 구독자의 selection set을 서빙
```

> `charge`만 rung 1인 것은 의도적이다 — 충전은 돈이 들어오는 경로라 유실이 정합성 문제이고, `spend`는 사용자가 이미 결과를 보고 있는 경로라 rung 0으로 충분하다. **한 모듈 안에 두 rung이 공존하는 것이 정상이며, 그게 사다리의 요점이다.**

## 14. 에러 처리

- 미인증 구독 시도 → `requirePrincipal`이 `UnauthenticatedError` → `maskedErrors`가 코드 `UNAUTHENTICATED`로 노출.
- 재조회에서 row가 없거나 소유권 불일치 → `findUniqueOrThrow`가 `P2025` → 마스킹된 내부 오류. 정상 시스템에서는 도달 불가(법칙 4). 도달하면 발행 키가 잘못된 것이므로 오류로 드러나는 게 맞다.
- Redis 연결 끊김 → ioredis가 자체 재연결. **rung 0의 이벤트는 그동안 유실되고, rung 1은 유실되지 않는다** — 아웃박스 row가 `publishedAt IS NULL`로 남아 다음 드레인에 나간다. 이것이 두 rung의 실질적 차이가 드러나는 대표 상황이다.
- 아웃박스 발행 실패 → `attempts` 증가, 다음 드레인에 재시도. 상한 도달 시 `failedAt` 스탬프 + 로그(DLQ).
- 구독 중 에러는 graphql-ws에서 구독을 **종료**시킨다. 클라이언트 재연결 + 재조회가 복구 경로다.

## 15. 테스트

| 파일 | 내용 |
|---|---|
| `src/tests/events/rate.prop.test.ts` | §8.2의 프로퍼티 5개 |
| `src/tests/events/operators.test.ts` | trailing edge 보장, 취소 시 upstream `return()` 전파, `minIntervalMs: 0` identity |
| `src/tests/events/event-bus.test.ts` | 토픽 라우팅, 키 격리(다른 userId의 이벤트가 새지 않음), 옵션 적용 |
| `src/tests/events/outbox.test.ts` | **트랜잭션 원자성: 롤백 시 아웃박스 row 0건.** `notify()` 없이도 `drain()`이 집는다(크래시 재개). 발행 후 `publishedAt` 스탬프. 재드레인이 중복 발행하지 않음. `attempts` 상한 → `failedAt` |
| `src/tests/events/outbox.key.prop.test.ts` | 키 왕복: `keyKind`에 따른 직렬화/파싱이 항등 (프로퍼티) |
| `src/tests/modules/point/point.service.test.ts` (확장) | **rung 0: 커밋 후 정확히 1회 발행, 롤백 시 0회. rung 1: 커밋 후 아웃박스 1건, 롤백 시 0건** — crepe 결함의 회귀 고정 |
| `src/tests/modules/auth/auth.value.prop.test.ts` (확장) | `parseCredential` 우선순위·전 함수 |
| `src/tests/modules/auth/auth.service.test.ts` | 만료 세션은 principal을 주지 않음(고정 클럭) |
| `src/tests/e2e/subscription.test.ts` | **실제 소켓** — `app.listen({ port: 0 })` 후 SSE(`fetch` + `Accept: text/event-stream`)와 graphql-ws 양쪽. 미인증 구독 거부 포함. rung 1 경로(charge → 드레인 → 구독자 수신) 왕복 |
| `src/tests/e2e/schema-snapshot.test.ts` | `Subscription` 타입 추가 반영 |

서비스 테스트는 `createServices`에 **기록용 fake 버스**를 주입한다(`PostSearchIndex`/`GoogleOAuthClient`와 같은 자세). Redis 어댑터는 테스트하지 않는다.

**`SKIP LOCKED` 동시성은 PGlite에서 테스트할 수 없다** — 단일 커넥션이라 두 드레이너를 띄울 수 없다. CONVENTIONS §7이 이미 같은 한계를 기록한 자리(P2034 직렬화 실패)와 동일한 취급으로, 구조적 매핑만 검증하고 최악의 실패 모드가 "중복 발행"(법칙 1에 의해 무해)임을 근거로 수용한다.

## 16. crepe IAP 이식 가이드

§2.3의 F1·F2를 이 아키텍처로 옮기는 구체안. **아웃박스는 F2에만 쓰고, F1은 §6.4에 따라 아웃박스 없이 고친다.**

### 16.1 토픽 추가

```ts
// events/event-registry.ts
export const TOPICS = defineTopics({
  pointBalanceChanged: topic<number, { userId: number }>('number'),
  /**
   * 포인트 충전이 확정됨. 결제 수단과 무관하게 이 한 토픽으로 통일한다 —
   * iamport / tosspayments / IAP(Apple·Google)가 모두 여기로 발행한다.
   * 키 = accountId. crepe 의 'account:pointCharge' 를 대체한다.
   */
  pointChargeCompleted: topic<string, { pointChargeId: string }>('string'),
});
```

crepe의 기존 `account:pointCharge` 구독 필드(`pointChargeUpdateStream`)는 그대로 두고 발행 측만 이 토픽으로 옮긴다 — **클라이언트 변경 0**이다.

### 16.2 F2 수정 — grant 트랜잭션에 아웃박스 삽입

`service/iap/grant-google-purchase.ts`의 grant tx는 이미 advisory lock 2개 하의 단일 트랜잭션이다. 여기에 한 줄을 넣는다:

```ts
const result = await deps.db.$transaction(async ($tx) => {
  await acquireAdvisoryLocks($tx, { pointKey: intent.accountId, iapGooglePurchaseKey: purchaseToken });
  // … intent.consumedAt write-once → PointCharge → IapPurchase → IapGrant (기존 그대로)

  // 추가: 지급 확정을 같은 트랜잭션에 기록한다. 롤백되면 이벤트도 없다.
  await deps.outbox.enqueue($tx, 'pointChargeCompleted', intent.accountId, {
    pointChargeId: pointCharge.id,
  });

  return { purchase: created, alreadyGranted: false };
});
deps.outbox.notify();  // 커밋 후 웨이크업
```

**rung 1을 고르는 근거**: 지급된 포인트가 클라이언트에 반영되지 않으면 사용자는 "결제했는데 포인트가 안 들어왔다"고 인식한다. 유실이 UX 저하가 아니라 CS·환불 문제이므로 at-most-once로는 부족하다.

**멱등 재진입 경로에 주의한다.** `alreadyGranted: true`로 빠지는 분기(intent가 이미 consume됨)에서는 **아웃박스에 넣지 않는다** — 이미 최초 grant 때 넣었다. 이 분기가 곧 인박스 I5(터미널 전이 멱등)의 grant 측 대응물이다.

`grant-apple-purchase.ts`도 동일하게, `routes/iamport.ts`·`routes/tosspayments.ts`의 3개 발행 지점도 라우트에서 서비스로 옮기며 같은 형태로 바꾼다(법칙 3).

### 16.3 F1 수정 — `created` 게이트를 웨이크업에서 분리

```ts
// routes/iap-google.ts — 현재
if (persisted.created) {
  try { await enqueueApply(persisted.id); }
  catch { return reply.code(503).header('Retry-After', '10').send({ error: 'enqueue_failed' }); }
}
return reply.code(204).send();
```

```ts
// 이후 — 웨이크업은 created 와 무관하게 항상 시도하고, 실패해도 ack 한다.
// 인박스 row(PENDING)가 이미 내구성 있는 작업 항목이므로(I3) enqueue 는 지연 최적화일 뿐이다(I4).
try {
  await enqueueApply(persisted.id);
} catch (error) {
  logger.log({ level: 'warn', message: 'iap google rtdn enqueue failed; sweep will recover', ... });
}
return reply.code(204).send();
```

두 가지가 바뀐다.

1. **`created` 게이트 제거.** 재전송마다 웨이크업이 다시 걸리므로, 최초 enqueue가 실패한 알림이 60초 sweep에만 의존하지 않는다. `apply`는 이미 PENDING이 아닌 row를 멱등 skip하므로 중복 enqueue는 무해하다.
2. **enqueue 실패에 503이 아니라 204.** 현재는 503 → Google 재전송 → 게이트가 닫혀 enqueue 스킵이라는 **역효과**가 난다. 인박스 row가 커밋된 이상 작업은 유실되지 않으므로 ack하는 것이 옳다.

`persist` 자체의 실패는 지금처럼 503을 유지한다 — 그때는 row가 없으므로 재전송이 유일한 복구 경로다.

### 16.4 이식 후 파이프라인

```
RTDN webhook (at-least-once)
  OIDC 검증 → rate limit → env 확인
  → persist [IapNotification, unique(platform, notificationId)]   ← 인박스, 커밋
  → enqueue 시도 (실패해도 204 — sweep 이 권위)                    ← I4
  → 204
  apply → verify(Google API)
  → grant tx: intent consume + PointCharge + IapPurchase + IapGrant
             + outbox.enqueue('pointChargeCompleted')             ← 아웃박스, 같은 커밋
  → outbox.notify()
  → markNotificationProcessed()                                    ← I5
  드레이너 → publish → pointChargeUpdateStream 구독자에게 반영      ← F2 해소
  sweep → DLQ / 재-enqueue (기존 그대로, 이제 권위가 아니라 backstop)
```

### 16.5 이식 시 검증할 것

1. **`apply`의 멱등성이 중복 enqueue를 실제로 견디는지.** 게이트를 제거하면 동일 알림에 대해 apply가 동시에 두 번 돌 수 있다. grant tx의 advisory lock + `intent.consumedAt` write-once가 이를 막도록 설계돼 있으나, **동시 apply 통합 테스트로 확인**해야 한다. 이 검증이 §16.3 변경의 전제 조건이다.
2. **`amountMicros`가 `BigInt`**라 아웃박스 페이로드에 실으면 JSON 직렬화가 깨진다. 법칙 1(id만)을 지키면 애초에 문제가 없다 — 이식 시 페이로드에 금액을 넣고 싶은 유혹을 차단하는 구체적 근거로 쓴다.
3. **`accountId`(String)와 레퍼런스의 `userId`(Int)** 키 타입이 다르다. `keyKind` 태그가 이 차이를 컴파일 타임에 강제하므로 토픽별로 올바른 값을 넣었는지 확인한다.

## 17. crepe 마이그레이션 맵

CONVENTIONS §11에 CONVENTIONS §10의 "crepe migration map"과 같은 형식으로 넣는다.

| crepe today | gannet blueprint |
|---|---|
| 루트 `src/pubsub.ts` 싱글턴, import 시점에 Redis 커넥션 2개 | `events/event-registry.ts`(순수 카탈로그) + 컴포지션 루트에서 생성·주입되는 버스 |
| 15개 호출 지점에 토픽 문자열 리터럴 | 이름이 `TOPICS`에서 나옴 — 오타는 컴파일 에러 |
| 리졸버·라우트·유틸이 제각각 발행 | 서비스만 발행, 린트로 강제 (법칙 3) |
| 쓰기 옆에서 발행, 커밋 보장 없음 | 커밋 이후 발행 (법칙 4). 유실 불가 경로는 아웃박스 (rung 1) |
| **IAP 경로는 이벤트를 발행하지 않음** (iamport/toss와 비대칭) | grant tx의 아웃박스 삽입 → `pointChargeCompleted` (§16.2) |
| **인제스트 이중 쓰기 + `created` 게이트가 재전송 시 enqueue 스킵** | 인박스 row가 작업 큐, 웨이크업은 최적화 (I3·I4, §16.3) |
| `subscribe: (…, { session }) => pubsub.subscribe('user:x', session!.userId)` | `ctx.events.subscribe(…, requirePrincipal(ctx).userId)` — `!` 없음 |
| `resolve`가 `where: { id }`만 (notification 제외) | `where`가 매 이벤트마다 구독자 가시성을 재확인 (법칙 5) |
| `createContext`의 쿠키/헤더/connectionParams if-else 사슬 | 순수 `parseCredential(source)` 하나, HTTP·WS 공용, 프로퍼티 테스트 |
| `connectionParams.accessToken` 우선 (XSS 우려를 주석으로 남김) | 쿠키 우선, `connectionParams`는 폐기 예정 호환 경로로 마지막 |
| 레이트 제어 없음 (`typing` 인디케이터 포함) | `SubscribeOptions.minIntervalMs` — 순수 정책 + 셸 |
| `/_/ws` + `@fastify/websocket` + graphql-ws | `/graphql/ws`, **같은 프로토콜** → 클라 변경은 URL 한 줄 |
| SSE 없음 | `/graphql`에서 SSE 기본 제공, ws는 호환용 유지 |
| shutdown TODO: WS 미드레인 | SIGTERM이 아웃박스 최종 드레인 → 구독 1001 종료 → `app.close()` |
| `pubsub`을 어디서나 import 가능 | schema는 subscribe 전용 `ctx.events`, `publish`는 타입상 도달 불가 |

**하위 호환 결론: 와이어 호환된다.** crepe 프론트/네이티브는 graphql-ws를 그대로 쓰고 URL만 바꾸면 된다. IAP 이식도 구독 필드 시그니처를 건드리지 않으므로 클라이언트 변경이 없다.

## 18. 범위 밖 (의도적)

- **authz 레이어**(crepe의 `@pothos/plugin-scope-auth` 상당). 구독 경계의 `requirePrincipal`만 도입한다 — graduation rule.
- **레퍼런스의 인박스 구현.** at-least-once 인바운드 표면이 없어 코드로 실으면 죽은 코드가 된다. 규칙(§6.5)과 crepe 참조 구현으로 대신한다.
- **아웃박스의 잡 enqueue 싱크.** §6.4의 규칙에 따라 만들지 않는다.
- **아웃박스의 순서 보장.** §6.3에 명시적으로 포기한다.
- **DM 모듈 이식.** crepe의 구독 6개 중 DM 4개는 대응 모듈이 없다.
- **Postgres `LISTEN/NOTIFY` 어댑터.** 포트는 남기되 이번에 구현하지 않는다.
- **Rx 도입.** §3.1의 재검토 트리거 참조.
- **crepe IAP의 실제 이식 작업.** 이 문서는 설계와 가이드까지다(§16). 실행은 crepe 저장소의 별도 작업.

## 19. 리스크 / 검증 포인트

1. ~~**SSE가 현재 Fastify 라우트를 통해 실제로 스트리밍되는지.**~~ **[해소됨 — 2026-07-27 스파이크]** 기존 라우트 형태(`handleNodeRequestAndResponse` + 멀티파트 `addContentTypeParser`) 그대로 스트리밍된다. 응답 헤더가 21ms에 도착했고(`content-type: text/event-stream`), **구독 수립 이후에** 발행한 이벤트가 `event: next` 프레임으로 전달됐다. SSE 전용 라우트 분리는 불필요하다.
2. **`@envelop/opentelemetry`의 오퍼레이션 span이 구독 수명 전체를 덮는지.** 덮으면 몇 시간짜리 span이 나간다.
3. **async generator 체인의 `return()` 전파.** `throttle`이 대기 중일 때 취소되는 경로에서 upstream이 정리되지 않으면 누수다.
4. ~~**`t.prismaField`가 `subscriptionFields` 안에서 Pothos prisma 플러그인 v4와 동작하는지.**~~ **[해소됨 — 2026-07-27 스파이크]** `builder.subscriptionType({})` 후 `subscriptionFields`에서 `t.prismaField({ type: 'PointBalance' })`가 빌드되고, **중첩 relation(`user { email }`)까지 해석된다** — 구독 resolve 경로에서도 Pothos `query` 전개가 정상 동작한다. graphql-ws over `@fastify/websocket` + `yoga.getEnveloped()` 경로도 같은 스파이크에서 확인했다.
5. **컨텍스트 팩토리 async 전환의 파급.** 기존 e2e가 동기 팩토리를 가정하지 않는지 확인. 인증 요청당 DB 왕복 1회 추가.
6. **PGlite 단일 커넥션.** e2e 구독 테스트에서 쓰기와 구독 재조회가 한 커넥션을 공유한다. **법칙 4(커밋 후 발행)가 이를 안전하게 만든다** — 열린 트랜잭션 안에서 발행하면 재조회가 같은 커넥션에서 교착할 수 있다. 어겼을 때 테스트가 즉시 실패하는 지점이다.
7. **`FOR UPDATE SKIP LOCKED`를 PGlite가 파싱은 하되 동시성을 재현할 수 없다**(§15). 구조적 매핑만 검증하고, 최악의 실패 모드가 중복 발행(법칙 1에 의해 무해)임을 근거로 수용한다.
8. **아웃박스 드레인이 스케줄러에 묶인다.** `SCHEDULER_ENABLED=false`인 프로세스는 `notify()` 경로로만 드레인하므로, 최소 한 프로세스가 스케줄러를 켜야 한다는 운영 조건이 생긴다(§11.4). 이 조건을 README에 적고, 위반 시 조용히 지연되는 대신 눈에 띄도록 미발행 row 수를 메트릭으로 노출할지 검토한다.
9. **`BigInt` id.** `OutboxEvent.id`가 `BigInt`라 Prisma가 JS `bigint`를 돌려준다. 로깅·직렬화 경로에서 `JSON.stringify`가 던지므로 드레이너 내부에 갇히도록 주의한다.

## 20. 변경 파일 요약

| 파일 | 변경 | 단계 |
|---|---|---|
| `src/events/events.ts` | 신규 — 순수 머신러리 | B |
| `src/events/event-registry.ts` | 신규 — `TOPICS` | B |
| `src/events/rate.ts` | 신규 — 순수 정책 `planEmit` | B |
| `src/events/operators.ts` | 신규 — 셸 `throttle` | B |
| `src/events/event-bus.ts` | 신규 — I/O 셸 | B |
| `src/events/redis-event-target.ts` | 신규 — 드라이버 | B |
| `src/events/outbox.repo.ts` | 신규 — 삽입/클레임/표시/퍼지 | C |
| `src/events/outbox.ts` | 신규 — 드레이너 셸 | C |
| `src/events/outbox.job.ts` | 신규 — `events:outbox:drain` / `:purge` | C |
| `src/modules/point/schemas/point.subscription.ts` | 신규 — `pointBalanceChanged` | B |
| `src/modules/point/schemas/index.ts` | `registerPointSubscriptions()` 호출 | B |
| `src/modules/point/point.service.ts` | rung 0 발행 3곳 + rung 1 아웃박스(`charge`) | B, C |
| `src/modules/auth/auth.value.ts` | 신규 — `parseCredential` | A |
| `src/modules/auth/auth.repo.ts` | 신규 — `findSessionByToken` | A |
| `src/modules/auth/auth.service.ts` | 신규 — `resolvePrincipal` | A |
| `src/modules/auth/oauth.service.ts` | 콜백 성공 시 세션 mint | A |
| `src/modules/auth/routes/oauth.route.ts` | 세션 쿠키 세팅 | A |
| `src/graphql/builder.ts` | `builder.subscriptionType({})` | B |
| `src/graphql/context.ts` | `principal`, `events`, `'subscription'` 종류, `requirePrincipal`, async 팩토리 | A, B |
| `src/scheduler/scheduler.ts` | 아웃박스 잡 등록 | C |
| `src/app.ts` | `eventTarget` 옵션, 버스·아웃박스 생성, WS 등록, `ownsEventTarget` | B, C |
| `src/server.ts` | Redis 타깃 생성, 셧다운 순서(최종 드레인 포함) | B, C |
| `src/services.ts` | 버스·아웃박스를 서비스에 주입 | B, C |
| `src/foundation/errors.ts` | `UnauthenticatedError` | A |
| `prisma/schema.prisma` + 마이그레이션 2개 | `Session`(A), `OutboxEvent` + 부분 인덱스(C) | A, C |
| `.oxlintrc.json` | 레이어 5곳에 events/outbox 글롭 + 파일 목록 확장 | B, C |
| `.dependency-cruiser.mjs` | `events/`는 modules를 import 불가 | B |
| `.env.example` | `REDIS_URL` | B |
| `README.md` | Architecture에 `events/`, "Subscriptions (realtime)", 스케줄러 운영 조건 | B, C |
| `CONVENTIONS.md` | §11 신설 — 다섯 법칙, 전달 사다리, 연산자 규칙, Rx 트리거, crepe 맵 | B, C |
| `src/tests/events/*`, `src/tests/e2e/subscription.test.ts` 외 | §15 참조 | A, B, C |

**신규 의존성**: `ioredis`, `graphql-ws`, `@fastify/websocket`, `@graphql-yoga/redis-event-target@^3.0.3` (버전 제약 근거는 §4)
