/**
 * JobMonitor implementation.
 *
 * Polls squeue (via SchedulingService) and emits JobEvent on state
 * changes. Uses backoff per R13: initial interval 30s, backing off
 * to 5 min. Stops polling once a terminal state is reached (INV-S4).
 *
 * The monitor returns an AsyncObservable that supports both async
 * iteration and callback subscription.
 *
 * Spec: api-contracts.md §2 (JobMonitor); invariants.md INV-S1,
 * INV-S4; resolutions.md R13; features/job-management.feature.
 */

import type {
  AsyncObservable,
  JobEvent,
  JobId,
  JobState,
} from '../types';
import type { Job } from '../types';
import {
  isTerminalJobState,
} from '../types/value-objects';
import type { SchedulingService, JobMonitor } from './types';
import {
  DEFAULT_SCHEDULING_CONFIG,
} from './types';
import type { SchedulingConfig } from './types';

// ============================================================================
// JobMonitorConfig
// ============================================================================

/**
 * Configuration for JobMonitorImpl. Inherits the polling intervals
 * from SchedulingConfig (R13: 30s initial, 5 min max, 1.5x backoff).
 */
export type JobMonitorConfig = SchedulingConfig;

/**
 * Monitors a SLURM Job by polling SchedulingService.queryJob(),
 * emitting JobEvent on state changes.
 *
 * INV-S1: All states come from the Scheduler (via SchedulingService).
 * INV-S4: Polling stops once a terminal state is reached.
 * R13: Polls with backoff (30s initial, 5 min max).
 *
 * Spec: api-contracts.md §2 (JobMonitor); module-graph.md §2.
 */
export class JobMonitorImpl implements JobMonitor {
  #service: SchedulingService;
  #config: SchedulingConfig;

  constructor(
    service: SchedulingService,
    config?: Partial<SchedulingConfig>,
  ) {
    this.#service = service;
    this.#config = { ...DEFAULT_SCHEDULING_CONFIG, ...config };
  }

  watch(jobId: JobId): AsyncObservable<JobEvent> {
    return new JobWatchObservable(
      this.#service,
      jobId,
      this.#config,
    );
  }
}

// ============================================================================
// JobWatchObservable
// ============================================================================

/**
 * An AsyncObservable that polls SchedulingService.queryJob() and
 * emits JobEvent on state changes. Supports both async iteration
 * and callback subscription.
 *
 * The observable:
 * 1. Polls queryJob() at the configured interval (with backoff).
 * 2. Emits a JobStateChanged event when the Job's state changes.
 * 3. Emits a JobTimeout event when the Job reaches TIMEOUT.
 * 4. Emits a JobNodeFail event when the Job reaches NODE_FAIL.
 * 5. Emits a JobUnknown event when queryJob throws SchedulerUnavailable.
 * 6. Stops polling once a terminal state is reached (INV-S4) or
 *    cancel() is called.
 *
 * Spec: api-contracts.md (AsyncObservable Type); resolutions.md R13.
 */
class JobWatchObservable implements AsyncObservable<JobEvent> {
  #service: SchedulingService;
  #jobId: JobId;
  #config: SchedulingConfig;
  #subscribers: Set<(event: JobEvent) => void> = new Set();
  #cancelled = false;
  #lastState: JobState | null = null;
  #pollInterval: number;
  #pollTimer: ReturnType<typeof setTimeout> | null = null;
  #iteratorQueue: JobEvent[] = [];
  #iteratorResolvers: ((value: IteratorResult<JobEvent>) => void)[] = [];

  constructor(
    service: SchedulingService,
    jobId: JobId,
    config: SchedulingConfig,
  ) {
    this.#service = service;
    this.#jobId = jobId;
    this.#config = config;
    this.#pollInterval = config.initialPollIntervalMs;
    // Start polling immediately (first poll on next tick)
    this.#schedulePoll(0);
  }

  // ========================================================================
  // AsyncObservable interface
  // ========================================================================

  [Symbol.asyncIterator](): AsyncIterator<JobEvent> {
    return {
      next: (): Promise<IteratorResult<JobEvent>> => {
        if (this.#iteratorQueue.length > 0) {
          const event = this.#iteratorQueue.shift();
          if (event !== undefined) {
            return Promise.resolve({ value: event, done: false });
          }
        }
        if (this.#cancelled && this.#iteratorQueue.length === 0) {
          return Promise.resolve({ value: undefined as unknown as JobEvent, done: true });
        }
        return new Promise((resolve) => {
          this.#iteratorResolvers.push(resolve);
        });
      },
    };
  }

  subscribe(callback: (event: JobEvent) => void): () => void {
    this.#subscribers.add(callback);
    return () => {
      this.#subscribers.delete(callback);
    };
  }

  cancel(): void {
    this.#cancelled = true;
    if (this.#pollTimer !== null) {
      clearTimeout(this.#pollTimer);
      this.#pollTimer = null;
    }
    // Resolve any pending iterators
    for (const resolver of this.#iteratorResolvers) {
      resolver({ value: undefined as unknown as JobEvent, done: true });
    }
    this.#iteratorResolvers = [];
  }

  // ========================================================================
  // Polling
  // ========================================================================

  #schedulePoll(delay: number): void {
    if (this.#cancelled) return;
    this.#pollTimer = setTimeout(() => {
      this.#poll().catch(() => {
        // Error already handled in #poll
      });
    }, delay);
  }

  async #poll(): Promise<void> {
    if (this.#cancelled) return;

    let job: Job;
    try {
      job = await this.#service.queryJob(this.#jobId);
    } catch (error) {
      // If the error is SchedulerUnavailable, emit JobUnknown
      if (
        error instanceof Error &&
        'kind' in error &&
        (error as { kind: string }).kind === 'scheduler_unavailable'
      ) {
        this.#emit({
          kind: 'job_unknown',
          jobId: this.#jobId,
          reason: error.message,
          retryAfterMs: this.#pollInterval,
          timestamp: new Date(),
        });
        // Continue polling with backoff
        this.#applyBackoff();
        this.#schedulePoll(this.#pollInterval);
      }
      return;
    }

    const newState = job.state;

    // Emit state change if this is the first poll or the state changed
    if (this.#lastState === null || this.#lastState !== newState) {
      if (this.#lastState !== null) {
        this.#emit({
          kind: 'job_state_changed',
          jobId: this.#jobId,
          previousState: this.#lastState,
          newState,
          source: 'squeue',
          timestamp: new Date(),
        });
      } else {
        // First poll — emit the initial state
        this.#emit({
          kind: 'job_state_changed',
          jobId: this.#jobId,
          previousState: 'UNKNOWN',
          newState,
          source: 'squeue',
          timestamp: new Date(),
        });
      }
      this.#lastState = newState;
    }

    // Emit specific terminal events
    if (newState === 'TIMEOUT') {
      this.#emit({
        kind: 'job_timeout',
        jobId: this.#jobId,
        wallTime: job.resourceRequest.wallTime,
        timestamp: new Date(),
      });
    }

    if (newState === 'NODE_FAIL') {
      this.#emit({
        kind: 'job_node_fail',
        jobId: this.#jobId,
        failedNodes: [],
        timestamp: new Date(),
      });
    }

    // INV-S4: stop polling once a terminal state is reached
    if (isTerminalJobState(newState)) {
      this.#cancelled = true;
      // Resolve any pending iterators
      for (const resolver of this.#iteratorResolvers) {
        resolver({ value: undefined as unknown as JobEvent, done: true });
      }
      this.#iteratorResolvers = [];
      return;
    }

    // Continue polling with backoff
    this.#applyBackoff();
    this.#schedulePoll(this.#pollInterval);
  }

  #applyBackoff(): void {
    this.#pollInterval = Math.min(
      this.#pollInterval * this.#config.backoffMultiplier,
      this.#config.maxPollIntervalMs,
    );
  }

  #emit(event: JobEvent): void {
    // Notify subscribers
    for (const sub of this.#subscribers) {
      sub(event);
    }
    // Push to iterator queue and resolve pending iterators
    this.#iteratorQueue.push(event);
    const resolver = this.#iteratorResolvers.shift();
    if (resolver !== undefined) {
      const e = this.#iteratorQueue.shift();
      if (e !== undefined) {
        resolver({ value: e, done: false });
      }
    }
  }
}
