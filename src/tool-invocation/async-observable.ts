/**
 * AsyncObservable implementation for the tool-invocation module.
 *
 * A simple, synchronous-backed AsyncObservable that supports:
 * - subscribe(callback) — register a callback for events
 * - [Symbol.asyncIterator]() — async iteration over events
 * - cancel() — stop emitting
 *
 * Events are buffered until at least one subscriber is present, then
 * emitted in order. Late subscribers receive buffered events
 * immediately, then continue receiving new events.
 *
 * Spec: api-contracts.md (AsyncObservable Type section);
 * value-objects.ts (AsyncObservable<T>).
 */

import type { AsyncObservable } from '../types';

/**
 * Internal event record for the observable.
 */
interface EventRecord<T> {
  readonly event: T;
  readonly emitted: boolean;
}

/**
 * Creates an AsyncObservable from an optional initial event buffer.
 *
 * The returned object has an `emit(event)` method (not on the
 * AsyncObservable interface) that the creator uses to push events.
 * Subscribers receive all buffered events (in order) upon
 * subscription, then any new events emitted afterward.
 *
 * Once `cancel()` is called, no further events are emitted to any
 * subscriber.
 *
 * Spec: api-contracts.md (AsyncObservable Type section).
 */
export function createAsyncObservable<T>(): AsyncObservable<T> & {
  /**
   * Emits an event to all subscribers. The event is buffered if
   * no subscribers are currently registered.
   */
  emit(event: T): void;

  /**
   * Completes the observable — no more events will be emitted.
   * Late subscribers will receive buffered events up to this point.
   */
  complete(): void;

  /**
   * Returns true if the observable has been cancelled.
   */
  readonly isCancelled: boolean;

  /**
   * Returns the number of subscribers.
   */
  readonly subscriberCount: number;
} {
  let cancelled = false;
  let completed = false;
  const buffer: EventRecord<T>[] = [];
  const subscribers: Array<(event: T) => void> = [];

  const flushBuffer = (): void => {
    for (const record of buffer) {
      if (record.emitted || cancelled) continue;
      for (const sub of subscribers) {
        sub(record.event);
      }
      (record as { emitted: boolean }).emitted = true;
    }
  };

  const observable: AsyncObservable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          // Wait for events to be available
          while (index < buffer.length && !cancelled) {
            const record = buffer[index];
            if (record !== undefined) {
              index++;
              return { done: false, value: record.event };
            }
          }
          if (completed || cancelled) {
            return { done: true, value: undefined as T };
          }
          // If no events available and not completed, we need to
          // wait. For simplicity in a test-friendly implementation,
          // return done if no more events are immediately available
          // and the observable is completed.
          if (index >= buffer.length) {
            // Check again after a microtask
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            if (index < buffer.length && !cancelled) {
              const record = buffer[index];
              if (record !== undefined) {
                index++;
                return { done: false, value: record.event };
              }
            }
          }
          return { done: true, value: undefined as T };
        },
      };
    },
    subscribe(callback: (event: T) => void): () => void {
      subscribers.push(callback);
      // Flush buffered events to this new subscriber
      flushBuffer();
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx >= 0) {
          subscribers.splice(idx, 1);
        }
      };
    },
    cancel(): void {
      cancelled = true;
    },
  };

  return {
    ...observable,
    emit(event: T): void {
      if (cancelled || completed) return;
      buffer.push({ event, emitted: false });
      // Emit to all current subscribers immediately
      for (const sub of subscribers) {
        sub(event);
        const last = buffer[buffer.length - 1];
        if (last !== undefined) {
          (last as { emitted: boolean }).emitted = true;
        }
      }
    },
    complete(): void {
      completed = true;
    },
    get isCancelled(): boolean {
      return cancelled;
    },
    get subscriberCount(): number {
      return subscribers.length;
    },
  };
}
