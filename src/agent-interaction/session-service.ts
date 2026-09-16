/**
 * SessionService implementation (C7).
 *
 * Manages the interaction context between a User and the Agent.
 *
 * Lifecycle:
 * - startSession: creates a new ACTIVE Session and proactively
 *   queries the Scheduler for Jobs belonging to the User (R7,
 *   ADR-007). This is the default behavior, not on-demand.
 * - endSession: marks the Session as ENDED but does NOT cancel
 *   any running Jobs (INV-W4). Workflow state is persisted (R6,
 *   ADR-006).
 * - getSession: retrieves a Session by identity (even after it
 *   has ended, for auditing).
 * - reportJobStatus: queries the Scheduler and returns
 *   JobStatusReport[] for the Session's User.
 *
 * Invariant enforced:
 * - INV-W4: Session can outlive its Jobs' completion.
 *   endSession() sets SessionState to ENDED but does not call
 *   scheduling.cancelJob() for any Job. A later Session can
 *   become aware of those Jobs by JobID via
 *   scheduling.queryJobsByUser().
 *
 * Resolutions:
 * - R7: Proactive Job reporting on Session start (default, not
 *   on-demand).
 *
 * Spec: api-contracts.md §7 (SessionService); module-graph.md §7;
 * invariants.md INV-W4; resolutions.md R7; ADR-007.
 */

import type { SchedulingService } from '../scheduling/types';
import type {
  Job,
  Session,
  SessionEvent,
  SessionId,
  SessionState,
  User,
} from '../types';
import type {
  JobStatusReport,
  SessionServiceConfig,
} from './types';
import { createSessionId } from './types';

// ============================================================================
// SessionServiceImplProps
// ============================================================================

/**
 * Constructor parameters for SessionServiceImpl.
 *
 * `scheduling` — used for proactive Job reporting (R7) and
 *   on-demand Job status queries.
 * `config` — optional partial override of the default Session
 *   configuration.
 * `onEvent` — callback invoked when SessionEvents are produced.
 */
export interface SessionServiceImplProps {
  readonly scheduling: SchedulingService;
  readonly config?: Partial<SessionServiceConfig>;
  readonly onEvent?: (event: SessionEvent) => void;
}

// ============================================================================
// Internal session tracking
// ============================================================================

/**
 * Internal mutable record tracking a Session.
 */
interface InternalSessionRecord {
  session: Session;
}

// ============================================================================
// SessionServiceImpl
// ============================================================================

/**
 * SessionService implementation.
 *
 * INV-W4: Session can outlive its Jobs' completion. endSession()
 * does NOT cancel running Jobs.
 *
 * R7: Proactive Job reporting on Session start (default, not
 * on-demand).
 *
 * Spec: api-contracts.md §7; invariants.md INV-W4;
 * resolutions.md R7; ADR-007.
 */
export class SessionServiceImpl {
  #scheduling: SchedulingService;
  #onEvent?: (event: SessionEvent) => void;
  #sessions: Map<string, InternalSessionRecord> = new Map();

  constructor(props: SessionServiceImplProps) {
    this.#scheduling = props.scheduling;
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // startSession (R7, ADR-007)
  // ========================================================================

  /**
   * Starts a new Session for a User.
   *
   * On start, proactively queries `scheduling.queryJobsByUser()`
   * and reports Job states to the User (R7, ADR-007). This is the
   * default behavior, not on-demand.
   *
   * If the Scheduler is unreachable, the Session is still created
   * and an empty proactive report is emitted (degradable, per
   * FM-S2).
   *
   * Spec: api-contracts.md §7; resolutions.md R7; ADR-007.
   */
  async startSession(user: User): Promise<Session> {
    const sessionId = createSessionId(
      `session-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    const now = new Date();

    const session: Session = Object.freeze({
      id: sessionId,
      user,
      state: 'ACTIVE' as SessionState,
      currentWorkflowId: null,
      loadedEnvironmentId: null,
      referencedDatasetIds: [],
      startedAt: now,
      endedAt: null,
    });

    this.#sessions.set(sessionId as string, { session });

    // Emit SessionStarted event
    this.#emitEvent({
      kind: 'session_started',
      sessionId,
      userId: user.username,
      timestamp: new Date(),
    });

    // R7: Proactively query the Scheduler for Jobs belonging to
    // the User. This is the default behavior, not on-demand.
    const jobReports = await this.#queryAndBuildJobReports(
      user.slurmUsername,
      sessionId,
    );

    // Emit SessionProactiveJobReport event
    this.#emitEvent({
      kind: 'session_proactive_job_report',
      sessionId,
      jobReports,
      timestamp: new Date(),
    });

    return session;
  }

  // ========================================================================
  // endSession (INV-W4)
  // ========================================================================

  /**
   * Ends the Session. Running Jobs are NOT cancelled (INV-W4).
   * The Session's Workflow state is persisted (R6, ADR-006).
   *
   * The Session remains retrievable via `getSession()` for
   * auditing purposes.
   *
   * @throws {Error} if the Session does not exist.
   * @throws {Error} if the Session is already ENDED.
   *
   * Spec: api-contracts.md §7; invariants.md INV-W4;
   * resolutions.md R6, R7; ADR-006, ADR-007.
   */
  async endSession(sessionId: SessionId): Promise<void> {
    const record = this.#sessions.get(sessionId as string);
    if (record === undefined) {
      throw new Error(`Session '${sessionId as string}' not found.`);
    }

    const existing = record.session;
    if (existing.state === 'ENDED') {
      throw new Error(
        `Session '${sessionId as string}' is already ENDED.`,
      );
    }

    // INV-W4: Running Jobs are NOT cancelled. endSession() only
    // marks the Session as ENDED. The Jobs continue on compute
    // nodes and are discoverable in later Sessions via
    // scheduling.queryJobsByUser().
    const ended: Session = Object.freeze({
      ...existing,
      state: 'ENDED',
      endedAt: new Date(),
    });
    record.session = ended;

    // Emit SessionEnded event with runningJobsPreserved: true
    this.#emitEvent({
      kind: 'session_ended',
      sessionId,
      runningJobsPreserved: true,
      timestamp: new Date(),
    });
  }

  // ========================================================================
  // getSession (auditing)
  // ========================================================================

  /**
   * Retrieves a Session by identity. Returns null if the Session
   * does not exist.
   *
   * The Session is retrievable even after it has ended (for
   * auditing purposes).
   *
   * Spec: api-contracts.md §7 (getSession).
   */
  async getSession(sessionId: SessionId): Promise<Session | null> {
    const record = this.#sessions.get(sessionId as string);
    if (record === undefined) {
      return null;
    }
    return record.session;
  }

  // ========================================================================
  // reportJobStatus (on-demand)
  // ========================================================================

  /**
   * Reports current Job states for the Session's User. Used both
   * proactively on Session start and on-demand.
   *
   * @throws {Error} if the Session does not exist.
   *
   * Spec: api-contracts.md §7 (reportJobStatus).
   */
  async reportJobStatus(sessionId: SessionId): Promise<JobStatusReport[]> {
    const record = this.#sessions.get(sessionId as string);
    if (record === undefined) {
      throw new Error(`Session '${sessionId as string}' not found.`);
    }

    return this.#queryAndBuildJobReports(
      record.session.user.slurmUsername,
      sessionId,
    );
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Queries the Scheduler for Jobs belonging to the User and
   * builds JobStatusReport[].
   *
   * If the Scheduler is unreachable (FM-S2), returns an empty
   * array (degradable). The caller is responsible for notifying
   * the User.
   */
  async #queryAndBuildJobReports(
    slurmUsername: string,
    _sessionId: SessionId,
  ): Promise<JobStatusReport[]> {
    let jobs: Job[];
    try {
      jobs = await this.#scheduling.queryJobsByUser(slurmUsername);
    } catch {
      // FM-S2: SLURM is unreachable. Degrade gracefully —
      // return an empty report. The Session is still active.
      jobs = [];
    }

    return jobs.map((job) => this.#buildJobStatusReport(job));
  }

  /**
   * Builds a JobStatusReport from a Job.
   *
   * The `caseId` and `workflowId` are included if the Job has
   * them (cross-referencing persisted Workflow state, per
   * ADR-007). Because `JobStatusReport` fields are readonly, the
   * report is constructed as a single object literal rather than
   * by mutating an intermediate value.
   */
  #buildJobStatusReport(job: Job): JobStatusReport {
    return {
      jobId: job.jobId,
      state: job.state,
      ...(job.caseId !== undefined ? { caseId: job.caseId } : {}),
      ...(job.workflowId !== undefined ? { workflowId: job.workflowId } : {}),
    };
  }

  /**
   * Emits a SessionEvent to the onEvent callback.
   */
  #emitEvent(event: SessionEvent): void {
    this.#onEvent?.(event);
  }
}
