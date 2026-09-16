/**
 * Unit tests for SessionService.
 *
 * Verifies the Session lifecycle: start → proactive Job report
 * (R7, ADR-007) → interact → end. Running Jobs survive Session end
 * (INV-W4). The Session can be retrieved after it has ended (for
 * auditing).
 *
 * Invariants:
 * - INV-W4: Session can outlive its Jobs' completion. endSession()
 *   does NOT cancel running Jobs.
 *
 * Resolutions:
 * - R7: Proactive Job reporting on Session start (default, not
 *   on-demand).
 *
 * Spec: build-phases.md Phase 5; api-contracts.md §7 (SessionService);
 * invariants.md INV-W4; resolutions.md R7; ADR-007.
 */

import { describe, it, expect } from 'vitest';
import { SessionServiceImpl } from '../../src/agent-interaction/session-service';
import type { SessionServiceImplProps } from '../../src/agent-interaction/session-service';
import type { SessionEvent } from '../../src/types';
import {
  createMockSchedulingService,
  createMockUser,
  createMockJob,
  createJobId,
  createSessionId,
} from './helpers';

// ============================================================================
// Test setup helper
// ============================================================================

interface SessionServiceSetup {
  readonly service: SessionServiceImpl;
  readonly scheduling: ReturnType<typeof createMockSchedulingService>;
  readonly events: SessionEvent[];
}

/**
 * Creates a SessionService with all mock dependencies.
 *
 * `queryJobsByUserResult` — Jobs to return from queryJobsByUser().
 * `user` — the User for startSession().
 */
function createSessionService(overrides: {
  readonly queryJobsByUserResult?: readonly ReturnType<typeof createMockJob>[];
  readonly user?: ReturnType<typeof createMockUser>;
  readonly config?: Partial<{ readonly proactiveJobReportTimeoutMs: number }>;
} = {}): SessionServiceSetup {
  const events: SessionEvent[] = [];
  const scheduling = createMockSchedulingService({
    queryJobsByUserResult: overrides.queryJobsByUserResult,
  });

  const props: SessionServiceImplProps = {
    scheduling,
    config: overrides.config,
    onEvent: (event: SessionEvent) => {
      events.push(event);
    },
  };

  const service = new SessionServiceImpl(props);

  return {
    service,
    scheduling,
    events,
  };
}

// ============================================================================
// startSession (R7, ADR-007)
// ============================================================================

describe('SessionServiceImpl — startSession', () => {
  it('creates a Session in ACTIVE state', async () => {
    const { service } = createSessionService();
    const user = createMockUser();

    const session = await service.startSession(user);

    expect(session.state).toBe('ACTIVE');
    expect(session.user).toEqual(user);
    expect(session.endedAt).toBeNull();
    expect(session.startedAt).toBeInstanceOf(Date);
  });

  it('generates a unique SessionId', async () => {
    const { service } = createSessionService();
    const user = createMockUser();

    const session1 = await service.startSession(user);
    const session2 = await service.startSession(user);

    expect(session1.id).not.toBe(session2.id);
  });

  it('proactively queries scheduling.queryJobsByUser() on start (R7, ADR-007)', async () => {
    const user = createMockUser({ slurmUsername: 'cera_user' });
    const { service, scheduling } = createSessionService({
      user,
      queryJobsByUserResult: [],
    });

    await service.startSession(user);

    // R7: proactive, not on-demand. queryJobsByUser is called
    // exactly once on start.
    expect(scheduling.queryJobsByUserCalls.length).toBe(1);
    expect(scheduling.queryJobsByUserCalls[0]).toBe('cera_user');
  });

  it('does NOT call scheduling.cancelJob() during startSession', async () => {
    const { service, scheduling } = createSessionService();
    const user = createMockUser();

    await service.startSession(user);

    expect(scheduling.cancelCalls.length).toBe(0);
  });

  it('emits SessionStarted event', async () => {
    const { service, events } = createSessionService();
    const user = createMockUser({ username: 'test_user' });

    const session = await service.startSession(user);

    const startedEvent = events.find((e) => e.kind === 'session_started');
    expect(startedEvent).toBeDefined();
    expect(startedEvent?.kind).toBe('session_started');
    if (startedEvent?.kind === 'session_started') {
      expect(startedEvent.sessionId).toBe(session.id);
      expect(startedEvent.userId).toBe('test_user');
    }
  });

  it('emits SessionProactiveJobReport event with Job states (R7)', async () => {
    const user = createMockUser({ slurmUsername: 'cera_user' });
    const job1 = createMockJob({ jobId: createJobId(4827365), state: 'RUNNING' });
    const job2 = createMockJob({ jobId: createJobId(4827366), state: 'COMPLETED' });

    const { service, events } = createSessionService({
      user,
      queryJobsByUserResult: [job1, job2],
    });

    const session = await service.startSession(user);

    const reportEvent = events.find((e) => e.kind === 'session_proactive_job_report');
    expect(reportEvent).toBeDefined();
    expect(reportEvent?.kind).toBe('session_proactive_job_report');
    if (reportEvent?.kind === 'session_proactive_job_report') {
      expect(reportEvent.sessionId).toBe(session.id);
      expect(reportEvent.jobReports.length).toBe(2);
      const job1Report = reportEvent.jobReports.find(
        (r) => r.jobId === 4827365,
      );
      expect(job1Report).toBeDefined();
      expect(job1Report?.state).toBe('RUNNING');
      const job2Report = reportEvent.jobReports.find(
        (r) => r.jobId === 4827366,
      );
      expect(job2Report).toBeDefined();
      expect(job2Report?.state).toBe('COMPLETED');
    }
  });

  it('emits SessionProactiveJobReport even when no Jobs exist', async () => {
    const user = createMockUser();
    const { service, events } = createSessionService({
      user,
      queryJobsByUserResult: [],
    });

    const session = await service.startSession(user);

    const reportEvent = events.find((e) => e.kind === 'session_proactive_job_report');
    expect(reportEvent).toBeDefined();
    if (reportEvent?.kind === 'session_proactive_job_report') {
      expect(reportEvent.sessionId).toBe(session.id);
      expect(reportEvent.jobReports.length).toBe(0);
    }
  });

  it('handles scheduling.queryJobsByUser() error gracefully', async () => {
    const user = createMockUser();
    const { events } = createSessionService({
      user,
    });

    // Override queryJobsByUser to throw
    const scheduling = createMockSchedulingService({
      queryJobsByUserError: new Error('SLURM unreachable'),
    });
    const props: SessionServiceImplProps = {
      scheduling,
      onEvent: (event: SessionEvent) => {
        events.push(event);
      },
    };
    const errorService = new SessionServiceImpl(props);

    // Should NOT throw — degrade gracefully
    const session = await errorService.startSession(user);
    expect(session.state).toBe('ACTIVE');

    // Should still emit a proactive report (empty, with error note)
    const reportEvent = events.find((e) => e.kind === 'session_proactive_job_report');
    expect(reportEvent).toBeDefined();
    if (reportEvent?.kind === 'session_proactive_job_report') {
      // Jobs are empty because SLURM was unreachable
      expect(reportEvent.jobReports.length).toBe(0);
    }
  });
});

// ============================================================================
// endSession (INV-W4)
// ============================================================================

describe('SessionServiceImpl — endSession (INV-W4)', () => {
  it('sets Session state to ENDED', async () => {
    const { service } = createSessionService();
    const user = createMockUser();

    const session = await service.startSession(user);
    await service.endSession(session.id);

    const ended = await service.getSession(session.id);
    expect(ended?.state).toBe('ENDED');
    expect(ended?.endedAt).toBeInstanceOf(Date);
  });

  it('does NOT cancel running Jobs (INV-W4)', async () => {
    const user = createMockUser({ slurmUsername: 'cera_user' });
    const runningJob = createMockJob({ jobId: createJobId(4827365), state: 'RUNNING' });

    const { service, scheduling } = createSessionService({
      user,
      queryJobsByUserResult: [runningJob],
    });

    const session = await service.startSession(user);
    await service.endSession(session.id);

    // INV-W4: no Jobs are cancelled when Session ends
    expect(scheduling.cancelCalls.length).toBe(0);
  });

  it('emits SessionEnded event with runningJobsPreserved: true (INV-W4)', async () => {
    const { service, events } = createSessionService();
    const user = createMockUser();

    const session = await service.startSession(user);
    await service.endSession(session.id);

    const endedEvent = events.find((e) => e.kind === 'session_ended');
    expect(endedEvent).toBeDefined();
    expect(endedEvent?.kind).toBe('session_ended');
    if (endedEvent?.kind === 'session_ended') {
      expect(endedEvent.sessionId).toBe(session.id);
      expect(endedEvent.runningJobsPreserved).toBe(true);
    }
  });

  it('throws when ending an already-ended Session', async () => {
    const { service } = createSessionService();
    const user = createMockUser();

    const session = await service.startSession(user);
    await service.endSession(session.id);

    await expect(service.endSession(session.id)).rejects.toThrow();
  });

  it('throws when ending an unknown Session', async () => {
    const { service } = createSessionService();

    await expect(
      service.endSession(createSessionId('session-unknown')),
    ).rejects.toThrow();
  });
});

// ============================================================================
// getSession (auditing)
// ============================================================================

describe('SessionServiceImpl — getSession', () => {
  it('returns the Session by ID', async () => {
    const { service } = createSessionService();
    const user = createMockUser();

    const session = await service.startSession(user);
    const retrieved = await service.getSession(session.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved?.id).toBe(session.id);
    expect(retrieved?.user).toEqual(user);
  });

  it('returns null for an unknown Session ID', async () => {
    const { service } = createSessionService();

    const retrieved = await service.getSession(
      createSessionId('session-does-not-exist'),
    );
    expect(retrieved).toBeNull();
  });

  it('returns the Session even after it has ended (for auditing)', async () => {
    const { service } = createSessionService();
    const user = createMockUser();

    const session = await service.startSession(user);
    await service.endSession(session.id);

    const retrieved = await service.getSession(session.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.state).toBe('ENDED');
    expect(retrieved?.id).toBe(session.id);
  });

  it('supports multiple concurrent Sessions', async () => {
    const { service } = createSessionService();
    const user1 = createMockUser({ username: 'user1' });
    const user2 = createMockUser({ username: 'user2' });

    const session1 = await service.startSession(user1);
    const session2 = await service.startSession(user2);

    expect(session1.id).not.toBe(session2.id);

    const retrieved1 = await service.getSession(session1.id);
    const retrieved2 = await service.getSession(session2.id);

    expect(retrieved1?.user.username).toBe('user1');
    expect(retrieved2?.user.username).toBe('user2');

    // End one, other remains
    await service.endSession(session1.id);

    const stillActive = await service.getSession(session2.id);
    expect(stillActive?.state).toBe('ACTIVE');
  });
});

// ============================================================================
// reportJobStatus (on-demand)
// ============================================================================

describe('SessionServiceImpl — reportJobStatus (on-demand)', () => {
  it('queries scheduling and returns JobStatusReport[]', async () => {
    const user = createMockUser({ slurmUsername: 'cera_user' });
    const job1 = createMockJob({ jobId: createJobId(4827365), state: 'RUNNING' });
    const job2 = createMockJob({ jobId: createJobId(4827366), state: 'COMPLETED' });

    const { service, scheduling } = createSessionService({
      user,
      queryJobsByUserResult: [job1, job2],
    });

    const session = await service.startSession(user);

    // Clear the call from startSession
    scheduling.queryJobsByUserCalls.length = 0;

    const reports = await service.reportJobStatus(session.id);

    expect(reports.length).toBe(2);
    expect(reports.some((r) => r.jobId === 4827365 && r.state === 'RUNNING')).toBe(true);
    expect(reports.some((r) => r.jobId === 4827366 && r.state === 'COMPLETED')).toBe(true);
    expect(scheduling.queryJobsByUserCalls.length).toBe(1);
  });

  it('returns empty array when no Jobs exist', async () => {
    const user = createMockUser();
    const { service } = createSessionService({
      user,
      queryJobsByUserResult: [],
    });

    const session = await service.startSession(user);

    const reports = await service.reportJobStatus(session.id);
    expect(reports.length).toBe(0);
  });

  it('returns a JobStatusReport for each Job', async () => {
    const user = createMockUser({ slurmUsername: 'cera_user' });
    const jobs = [
      createMockJob({ jobId: createJobId(100), state: 'PENDING' }),
      createMockJob({ jobId: createJobId(200), state: 'RUNNING' }),
      createMockJob({ jobId: createJobId(300), state: 'COMPLETED' }),
    ];

    const { service } = createSessionService({
      user,
      queryJobsByUserResult: jobs,
    });

    const session = await service.startSession(user);
    const reports = await service.reportJobStatus(session.id);

    expect(reports.length).toBe(3);
    for (const report of reports) {
      expect(report).toHaveProperty('jobId');
      expect(report).toHaveProperty('state');
    }
  });

  it('throws for an unknown Session ID', async () => {
    const { service } = createSessionService();

    await expect(
      service.reportJobStatus(createSessionId('session-unknown')),
    ).rejects.toThrow();
  });
});
