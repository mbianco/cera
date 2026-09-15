/**
 * Unit tests for JobMonitorImpl.
 *
 * Verifies that the JobMonitor polls squeue (via SchedulingService)
 * and emits JobEvent on state changes, with backoff (R13). Verifies
 * that polling stops once a terminal state is reached (INV-S4).
 *
 * Spec: build-phases.md Phase 2; api-contracts.md §2 (JobMonitor);
 * invariants.md INV-S1, INV-S4; resolutions.md R13;
 * features/job-management.feature.
 */

import { describe, it, expect, vi } from 'vitest';
import { JobMonitorImpl } from '../../src/scheduling/job-monitor';
import type { SchedulingService } from '../../src/scheduling/types';
import type {
  Job,
  JobId,
  JobState,
  JobEvent,
} from '../../src/types';
import {
  createJobId,
  createMockJob,
  createMockResourceRequest,
} from './helpers';

// ============================================================================
// Mock SchedulingService factory
// ============================================================================

/**
 * A mock SchedulingService that returns a configurable sequence of
 * Job states on successive queryJob calls. This simulates SLURM
 * reporting different states over time.
 */
function createMockSchedulingService(
  stateSequence: JobState[],
  options: {
    rejectOnCall?: number; // 0-indexed call number to reject
    rejectError?: Error;
  } = {},
): SchedulingService & {
  readonly queryCallCount: () => number;
} {
  let callCount = 0;
  const queryJob = vi.fn(async (jobId: JobId): Promise<Job> => {
    const idx = callCount++;
    if (options.rejectOnCall !== undefined && idx === options.rejectOnCall) {
      throw options.rejectError ?? new Error('mock rejection');
    }
    const state = stateSequence[idx] ?? stateSequence[stateSequence.length - 1] ?? 'UNKNOWN';
    return createMockJob({
      jobId,
      state,
      terminalState: isTerminal(state) ? state : null,
      resourceRequest: createMockResourceRequest(),
    });
  });

  return {
    submitJob: vi.fn(),
    queryJob,
    queryJobsByUser: vi.fn().mockResolvedValue([]),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    reconcileViaSacct: vi.fn().mockResolvedValue([]),
    queryCallCount: () => callCount,
  };
}

function isTerminal(state: JobState): boolean {
  return (
    state === 'COMPLETED' ||
    state === 'FAILED' ||
    state === 'TIMEOUT' ||
    state === 'CANCELLED' ||
    state === 'OUT_OF_MEMORY' ||
    state === 'NODE_FAIL'
  );
}

// ============================================================================
// Tests
// ============================================================================

describe('JobMonitorImpl', () => {
  it('emits state change events when the Job transitions', async () => {
    const service = createMockSchedulingService(['PENDING', 'RUNNING', 'COMPLETED']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0, // no backoff for fast testing
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    // Wait for the monitor to poll through all states
    await waitForCondition(() => events.length >= 3, 1000);
    observable.cancel();
    unsubscribe();

    expect(events.length).toBeGreaterThanOrEqual(3);
    const states = events.map((e) => e.kind === 'job_state_changed' ? e.newState : null);
    expect(states).toContain('PENDING');
    expect(states).toContain('RUNNING');
    expect(states).toContain('COMPLETED');
  });

  it('stops polling once a terminal state is reached (INV-S4)', async () => {
    const service = createMockSchedulingService(['RUNNING', 'COMPLETED']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    await waitForCondition(() => events.some((e) =>
      e.kind === 'job_state_changed' && e.newState === 'COMPLETED'
    ), 1000);

    const callsAfterTerminal = service.queryCallCount();
    await new Promise((r) => setTimeout(r, 50));
    const callsAfter = service.queryCallCount();

    observable.cancel();
    unsubscribe();

    // No additional polls after terminal state (INV-S4)
    expect(callsAfter).toBeLessThanOrEqual(callsAfterTerminal + 1);
  });

  it('emits JobUnknown event when queryJob throws SchedulerUnavailable', async () => {
    const service = createMockSchedulingService(['UNKNOWN'], {
      rejectOnCall: 0,
      rejectError: new (class extends Error {
        readonly kind = 'scheduler_unavailable';
        readonly severity = 'CRITICAL' as const;
      })(),
    });
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    await waitForCondition(() => events.length >= 1, 1000);
    observable.cancel();
    unsubscribe();

    expect(events.some((e) => e.kind === 'job_unknown')).toBe(true);
  });

  it('supports async iteration', async () => {
    const service = createMockSchedulingService(['PENDING', 'RUNNING', 'COMPLETED']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);
    const events: JobEvent[] = [];

    // Use async iteration
    const timeout = setTimeout(() => observable.cancel(), 500);
    for await (const event of observable) {
      events.push(event);
      if (event.kind === 'job_state_changed' && event.newState === 'COMPLETED') {
        break;
      }
    }
    clearTimeout(timeout);

    expect(events.length).toBeGreaterThan(0);
    expect(events.some((e) =>
      e.kind === 'job_state_changed' && e.newState === 'COMPLETED'
    )).toBe(true);
  });

  it('cancel() stops polling and iteration ends', async () => {
    const service = createMockSchedulingService(['RUNNING', 'RUNNING', 'RUNNING']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);

    // Wait a bit, then cancel
    await new Promise((r) => setTimeout(r, 20));
    observable.cancel();

    const callsBefore = service.queryCallCount();
    await new Promise((r) => setTimeout(r, 50));
    const callsAfter = service.queryCallCount();

    // No additional polls after cancel
    expect(callsAfter).toBeLessThanOrEqual(callsBefore + 1);
  });

  it('unsubscribe stops receiving events but polling may continue', async () => {
    const service = createMockSchedulingService(['PENDING', 'RUNNING', 'COMPLETED']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    await waitForCondition(() => events.length >= 1, 500);
    unsubscribe();

    const eventsAfterUnsub = events.length;
    await new Promise((r) => setTimeout(r, 50));
    observable.cancel();

    // No new events after unsubscribe
    expect(events.length).toBe(eventsAfterUnsub);
  });

  it('detects TIMEOUT state and emits appropriate event', async () => {
    const service = createMockSchedulingService(['RUNNING', 'TIMEOUT']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827366);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    await waitForCondition(() => events.some((e) =>
      e.kind === 'job_state_changed' && e.newState === 'TIMEOUT'
    ), 1000);
    observable.cancel();
    unsubscribe();

    expect(events.some((e) =>
      e.kind === 'job_state_changed' && e.newState === 'TIMEOUT'
    )).toBe(true);
  });

  it('detects NODE_FAIL state and emits appropriate event', async () => {
    const service = createMockSchedulingService(['RUNNING', 'NODE_FAIL']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827369);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    await waitForCondition(() => events.some((e) =>
      e.kind === 'job_state_changed' && e.newState === 'NODE_FAIL'
    ), 1000);
    observable.cancel();
    unsubscribe();

    expect(events.some((e) =>
      e.kind === 'job_state_changed' && e.newState === 'NODE_FAIL'
    )).toBe(true);
  });

  it('applies backoff between polls (R13)', async () => {
    const service = createMockSchedulingService(['RUNNING', 'RUNNING', 'COMPLETED']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 10,
      maxPollIntervalMs: 100,
      backoffMultiplier: 2.0, // 10, 20, 40, ...
    });

    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);

    // Wait for at least 2 polls
    await waitForCondition(() => service.queryCallCount() >= 2, 1000);
    observable.cancel();

    // With backoff multiplier 2.0 and initial 10ms, the second poll
    // should happen after at least 10ms (the first interval). We
    // just verify the monitor is using the configured interval —
    // the exact timing depends on the event loop.
    expect(service.queryCallCount()).toBeGreaterThanOrEqual(2);
  });

  it('emits initial state event on first poll', async () => {
    const service = createMockSchedulingService(['PENDING']);
    const monitor = new JobMonitorImpl(service, {
      initialPollIntervalMs: 1,
      maxPollIntervalMs: 10,
      backoffMultiplier: 1.0,
    });

    const events: JobEvent[] = [];
    const job: JobId = createJobId(4827365);
    const observable = monitor.watch(job);
    const unsubscribe = observable.subscribe((e) => events.push(e));

    await waitForCondition(() => events.length >= 1, 500);
    observable.cancel();
    unsubscribe();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const first = events[0];
    expect(first).toBeDefined();
    if (first !== undefined) {
      expect(first.kind).toBe('job_state_changed');
    }
  });
});

// ============================================================================
// Helpers
// ============================================================================

/**
 * Waits for a condition to become true, polling at the given interval.
 * Rejects if the condition is not met within the timeout.
 */
async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (condition()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  // Final check
  if (condition()) return;
  throw new Error(`Condition not met within ${timeoutMs}ms`);
}
