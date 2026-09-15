/**
 * Public types for the scheduling module (C4 — SLURM).
 *
 * SLURM-only, no scheduler abstraction (R8, ADR-004). The types are
 * SLURM-specific: ResourceRequest matches sbatch flags, JobState
 * includes UNKNOWN for R13 (SLURM unavailability).
 *
 * Spec references: api-contracts.md §2; module-graph.md §2;
 * invariants.md INV-S1–S4; resolutions.md R8, R13; ADR-004.
 */

import type {
  AsyncObservable,
  Job,
  JobEvent,
  JobId,
  JobState,
  ResourceRequest,
} from '../types';

// ============================================================================
// SubmitJobInput
// ============================================================================

/**
 * Input for submitting a Job to SLURM via sbatch.
 *
 * The Scheduler assigns the JobID (INV-S3). The ResourceRequest is
 * immutable after submission (INV-S2).
 *
 * Spec: api-contracts.md §2 (SubmitJobInput).
 */
export interface SubmitJobInput {
  readonly resourceRequest: ResourceRequest;
  /** The sbatch script or command to execute. */
  readonly command: string;
  readonly workingDirectory?: string;
  readonly environmentVars?: Record<string, string>;
}

// ============================================================================
// JobStatusReport
// ============================================================================

/**
 * A human-readable Job status report, used by agent-interaction for
 * proactive Job reporting on Session start (R7) and on-demand queries.
 *
 * Spec: api-contracts.md §2 (JobStatusReport — inline in SessionService).
 */
export interface JobStatusReport {
  readonly jobId: JobId;
  readonly state: JobState;
  readonly message?: string;
}

// ============================================================================
// SchedulingConfig
// ============================================================================

/**
 * Configuration for the scheduling module.
 *
 * Polling intervals follow R13: start at 30s, back off to 5 min.
 * UNKNOWN is acceptable for up to 30 minutes during long-running runs.
 *
 * Spec: resolutions.md R13; failure-modes.md FM-S2.
 */
export interface SchedulingConfig {
  /** Initial polling interval for squeue (milliseconds). Default: 30000. */
  readonly initialPollIntervalMs: number;
  /** Maximum polling interval after backoff (milliseconds). Default: 300000 (5 min). */
  readonly maxPollIntervalMs: number;
  /** Backoff multiplier applied after each poll. Default: 1.5. */
  readonly backoffMultiplier: number;
  /** How long UNKNOWN is acceptable before alerting (milliseconds). Default: 1800000 (30 min). */
  readonly unknownAcceptableMs: number;
  /** Timeout for individual SLURM CLI commands (milliseconds). Default: 30000. */
  readonly commandTimeoutMs: number;
  /** Maximum retry attempts for write-style commands (sbatch). Default: 3. */
  readonly maxRetries: number;
}

/**
 * Default scheduling configuration per R13.
 * Initial poll: 30s, max poll: 5 min, backoff: 1.5x.
 */
export const DEFAULT_SCHEDULING_CONFIG: SchedulingConfig = {
  initialPollIntervalMs: 30_000,
  maxPollIntervalMs: 300_000,
  backoffMultiplier: 1.5,
  unknownAcceptableMs: 1_800_000,
  commandTimeoutMs: 30_000,
  maxRetries: 3,
};

// ============================================================================
// SchedulingService interface
// ============================================================================

/**
 * SLURM job management. SLURM-only, no scheduler abstraction
 * (R8, ADR-004).
 *
 * All Job states come from the Scheduler (INV-S1) — never inferred
 * from file existence. The ResourceRequest is immutable after
 * submission (INV-S2). The JobID is assigned by SLURM (INV-S3).
 * Terminal states are final (INV-S4).
 *
 * Spec: api-contracts.md §2; module-graph.md §2.
 */
export interface SchedulingService {
  /**
   * Submits a Job to SLURM via sbatch. The Scheduler assigns the
   * JobID (INV-S3). The ResourceRequest is immutable after
   * submission (INV-S2).
   *
   * @throws {RejectedByScheduler} if sbatch rejects the
   *   ResourceRequest (FM-S1).
   * @throws {SchedulerUnavailable} if SLURM is unreachable (FM-S2).
   */
  submitJob(request: SubmitJobInput): Promise<Job>;

  /**
   * Queries a single Job's state via squeue (active) or sacct
   * (historical). The state is authoritative — taken directly from
   * SLURM output, never inferred from file existence (INV-S1).
   *
   * @throws {SchedulerUnavailable} if SLURM is unreachable (FM-S2).
   */
  queryJob(jobId: JobId): Promise<Job>;

  /**
   * Queries all Jobs for a User. Used by agent-interaction for
   * proactive Job reporting on Session start (R7).
   *
   * @throws {SchedulerUnavailable} if SLURM is unreachable (FM-S2).
   */
  queryJobsByUser(username: string): Promise<Job[]>;

  /**
   * Cancels a Job via scancel.
   *
   * @throws {JobNotFound} if the Job does not exist.
   * @throws {SchedulerUnavailable} if SLURM is unreachable (FM-S2).
   */
  cancelJob(jobId: JobId): Promise<void>;

  /**
   * Reconciles Job states using sacct (historical data) after a
   * SLURM outage. Finds Jobs that completed during the outage
   * (FM-S2, R13).
   *
   * @throws {SchedulerUnavailable} if sacct fails for all Jobs.
   */
  reconcileViaSacct(jobIds: JobId[]): Promise<Job[]>;
}

// ============================================================================
// JobMonitor interface
// ============================================================================

/**
 * Monitors a SLURM Job by polling squeue, emitting JobEvent on state
 * changes. Used by tool-invocation to monitor long-running Jobs (CESM).
 *
 * Polls squeue with backoff (R13): 30s initially, backing off to 5 min.
 * Stops polling once a terminal state is reached (INV-S4).
 *
 * Spec: api-contracts.md §2 (JobMonitor); module-graph.md §2.
 */
export interface JobMonitor {
  /**
   * Returns an AsyncObservable that emits JobEvent on state changes.
   * The observable stops emitting once the Job reaches a terminal
   * state (INV-S4) or is cancelled.
   */
  watch(jobId: JobId): AsyncObservable<JobEvent>;
}
