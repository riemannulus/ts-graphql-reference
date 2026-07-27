import type { AppEventPublisher, AppTopics, TopicName } from '../../events/event-registry.js';
import type { TopicKey, TopicPayload } from '../../events/events.js';
import type { Outbox } from '../../events/outbox.js';

/**
 * Recording fakes for the two event seams — the analogue of `flag-reader-fake.ts`
 * and of the OAuth / search port fakes.
 *
 * These exist so a service test can assert the thing that actually matters about
 * publishing: that it happens AFTER the commit and NOT AT ALL when the
 * transaction rolls back. A recording array makes both provable in one line;
 * a real bus would only prove that some listener eventually saw something.
 */

/** One recorded call, in the order it was made. */
export interface RecordedEvent {
  readonly topic: string;
  readonly key: string | number;
  readonly payload: unknown;
}

export interface RecordingPublisher extends AppEventPublisher {
  /** Every `publish` call, oldest first. */
  readonly recorded: RecordedEvent[];
  /** Convenience: the recorded calls for one topic. */
  forTopic(topic: TopicName): RecordedEvent[];
}

/** A publisher that fans out to an array instead of a pubsub. */
export function recordingPublisher(): RecordingPublisher {
  const recorded: RecordedEvent[] = [];
  return {
    publish<K extends TopicName>(
      topic: K,
      key: TopicKey<AppTopics[K]>,
      payload: TopicPayload<AppTopics[K]>,
    ): void {
      recorded.push({ topic, key, payload });
    },
    recorded,
    forTopic(topic) {
      return recorded.filter((event) => event.topic === topic);
    },
  };
}

export interface FakeOutbox extends Outbox {
  /** Every `enqueue` call, oldest first. */
  readonly enqueued: RecordedEvent[];
  /** How many times a commit woke the drainer. */
  readonly notifyCount: () => number;
}

/**
 * An outbox that records instead of writing.
 *
 * Use it when the subject is the SERVICE (did it enqueue the right event, at the
 * right rung?). It deliberately does NOT write a row, so it cannot show the
 * atomicity property — that one needs the real `createOutbox` against a real
 * transaction, which is what `tests/events/outbox.test.ts` does.
 */
export function fakeOutbox(): FakeOutbox {
  const enqueued: RecordedEvent[] = [];
  let notifies = 0;
  return {
    enqueue<K extends TopicName>(
      _tx: unknown,
      topic: K,
      key: TopicKey<AppTopics[K]>,
      payload: TopicPayload<AppTopics[K]>,
    ): Promise<void> {
      enqueued.push({ topic, key, payload });
      return Promise.resolve();
    },
    notify() {
      notifies += 1;
    },
    drain() {
      return Promise.resolve(0);
    },
    purge() {
      return Promise.resolve(0);
    },
    enqueued,
    notifyCount: () => notifies,
  } as unknown as FakeOutbox;
}
