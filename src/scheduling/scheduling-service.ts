/**
 * DEV-ONLY (R14, ADR-012).
 *
 * In production, SchedulingService is implemented by
 * FirecRESTSchedulingService (via FirecREST compute endpoints).
 * This SLURM CLI implementation (sbatch, squeue, scancel, sacct
 * via SubprocessRunner) is only used in dev mode (--backend dev).
 *
 * Spec: resolutions-r14.md R14.6; ADR-012;
 * invariants-firecrest-primary.md FP-INV-4.
 */

/**
 * SchedulingService implementation (C4 — SLURM).
 *
 * Submits Jobs via sbatch, queries state via squeue (active) and
 * sacct (historical), cancels via scancel, and reconciles Job states
 * after SLURM outages via sacct (R13).
 *
 * SLURM-only (R8, ADR-004). All Job states come from SLURM output
 * (INV-S1). The ResourceRequest is immutable after submission (INV-S2).
 * The JobID is assigned by SLURM (INV-S3). Terminal states are final
 * (INV-S4).
 *
 * Uses dsh-adapter's SubprocessRunner for SLURM CLI execution and
 * ShellExecutor for simple command parsing. No dsh types leak in
 * public signatures.
 *
 * Spec: api-contracts.md §2; module-graph.md §2; invariants.md
 * INV-S1–S4; failure-modes.md FM-S1–S4; resolutions.md R8, R13;
 * ADR-004.
 */

import type {
  SubprocessRunner,
  ShellExecutor,
  ShellResult,
} from '../dsh-adapter/types';
import type {
  Job,
  JobId,
  JobState,
  UserId,
  JobEvent,
  ResourceRequest,
} from '../types';
import {
  RejectedByScheduler,
  SchedulerUnavailable,
  StaleQueueData,
  JobNotFound as JobNotFoundError,
} from '../types/errors';
import {
  isTerminalJobState,
} from '../types/value-objects';
import {
  parseSbatchOutput,
  parseSqueueOutput,
  parseSacctOutput,
} from './slurm-parser';
import type {
  SchedulingService,
  SchedulingConfig,
  SubmitJobInput,
} from './types';
import {
  DEFAULT_SCHEDULING_CONFIG,
} from './types';

// ============================================================================
// Branded ID factory (private to this module)
// ============================================================================

/**
 * Creates a JobId from a number parsed from SLURM output (INV-S3).
 * Uses a type assertion because the brand symbol is private to
 * value-objects.ts.
 */
function jobIdFromNumber(n: number): JobId {
  return n as JobId;
}

// ============================================================================
// SLURM command builders
// ============================================================================

/**
 * Builds the sbatch command args from a SubmitJobInput.
 *
 * sbatch flags derived from ResourceRequest (INV-S2 — immutable
 * after submission because the args are computed once and the
 * resulting Job holds the same ResourceRequest reference).
 */
function buildSbatchArgs(request: SubmitJobInput): string[] {
  const rr = request.resourceRequest;
  const args = [
    `--nodes=${rr.nodes}`,
    `--ntasks-per-node=${rr.coresPerNode}`,
    `--mem=${rr.memory}`,
    `--time=${rr.wallTime}`,
    `--partition=${rr.partition}`,
    `--qos=${rr.qos}`,
  ];
  if (request.workingDirectory) {
    args.push(`--chdir=${request.workingDirectory}`);
  }
  args.push(request.command);
  return args;
}

/**
 * Builds the sbatch environment variables from SubmitJobInput.
 * sbatch passes these via --export, but for simplicity we pass them
 * as the subprocess environment.
 */
function buildSbatchEnv(request: SubmitJobInput): Record<string, string> {
  return { ...request.environmentVars };
}

// ============================================================================
// Error detection
// ============================================================================

/**
 * SLURM connection error substrings that indicate the daemon is
 * unreachable (FM-S2). Case-insensitive.
 */
const SLURM_UNAVAILABLE_PATTERNS: readonly string[] = [
  'unable to contact',
  'connection refused',
  'connection timed out',
  'no route to host',
  'slurmd: error',
];

/**
 * Checks if a ShellResult indicates SLURM is unreachable (FM-S2).
 * Returns true if the exit code is non-zero and stderr contains a
 * connection error pattern.
 */
function isSlurmUnavailable(result: ShellResult): boolean {
  if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code === 0) {
    return false;
  }
  const stderrLower = result.stderr.toLowerCase();
  return SLURM_UNAVAILABLE_PATTERNS.some((p) => stderrLower.includes(p));
}

/**
 * Checks if a scancel result indicates the Job was not found.
 */
function isJobNotFoundResult(result: ShellResult): boolean {
  if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code === 0) {
    return false;
  }
  return result.stderr.toLowerCase().includes('not found');
}

// ============================================================================
// Internal Job tracking
// ============================================================================

/**
 * Internal mutable Job record. The `job` field is the immutable Job
 * that callers see. The `terminalState` is set once a terminal state
 * is observed (INV-S4).
 */
interface InternalJobRecord {
  job: Job;
  terminalState: JobState | null;
}

// ============================================================================
// SchedulingServiceImpl
// ============================================================================

/**
 * Constructor parameters for SchedulingServiceImpl.
 */
export interface SchedulingServiceImplProps {
  readonly subprocessRunner: SubprocessRunner;
  readonly shellExecutor: ShellExecutor;
  readonly userId: UserId;
  readonly config?: Partial<SchedulingConfig>;
  readonly onEvent?: (event: JobEvent) => void;
}

/**
 * SLURM job management service.
 *
 * INV-S1: All Job states come from SLURM output (squeue, sacct).
 *   The service never infers states from file existence.
 * INV-S2: The ResourceRequest is immutable after submission (type
 *   system + no update method).
 * INV-S3: The JobID is assigned by SLURM (parsed from sbatch output).
 * INV-S4: Terminal states are final. Stale squeue data showing
 *   non-terminal states after a terminal state is observed is
 *   ignored (FM-S3).
 *
 * Spec: api-contracts.md §2; invariants.md INV-S1–S4;
 * failure-modes.md FM-S1–S4; resolutions.md R8, R13; ADR-004.
 */
export class SchedulingServiceImpl implements SchedulingService {
  #subprocessRunner: SubprocessRunner;
  #shellExecutor: ShellExecutor;
  #userId: UserId;
  #config: SchedulingConfig;
  #onEvent?: (event: JobEvent) => void;
  #jobs: Map<number, InternalJobRecord> = new Map();

  constructor(props: SchedulingServiceImplProps) {
    this.#subprocessRunner = props.subprocessRunner;
    this.#shellExecutor = props.shellExecutor;
    this.#userId = props.userId;
    this.#config = { ...DEFAULT_SCHEDULING_CONFIG, ...props.config };
    this.#onEvent = props.onEvent;
  }

  // ========================================================================
  // submitJob
  // ========================================================================

  async submitJob(request: SubmitJobInput): Promise<Job> {
    const args = buildSbatchArgs(request);
    const env = buildSbatchEnv(request);
    const options = {
      env,
      timeout: this.#config.commandTimeoutMs,
    };

    let result: ShellResult;
    try {
      result = await this.#subprocessRunner.execute('sbatch', args, options);
    } catch (error) {
      throw new SchedulerUnavailable({
        command: 'sbatch',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (isSlurmUnavailable(result)) {
      throw new SchedulerUnavailable({
        command: 'sbatch',
        error: result.stderr,
      });
    }

    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      throw new RejectedByScheduler({
        resourceRequest: request.resourceRequest,
        slurmError: result.stderr.trim(),
      });
    }

    // Parse JobID from sbatch output (INV-S3)
    const jobIdNumber = parseSbatchOutput(result.stdout);
    const jobId = jobIdFromNumber(jobIdNumber);

    const now = new Date();
    const job: Job = {
      jobId,
      userId: this.#userId,
      resourceRequest: request.resourceRequest,
      state: 'PENDING',
      terminalState: null,
      submittedAt: now,
      completedAt: null,
    };

    this.#jobs.set(jobIdNumber, { job, terminalState: null });
    this.#emitJobSubmitted(jobId, request.resourceRequest);
    return job;
  }

  // ========================================================================
  // queryJob
  // ========================================================================

  async queryJob(jobId: JobId): Promise<Job> {
    const jobIdNumber = jobId as number;
    const record = this.#jobs.get(jobIdNumber);

    // Try squeue first (active Jobs)
    const squeueResult = await this.#runSqueue(jobIdNumber);

    if (squeueResult !== null) {
      const state = squeueResult;

      // INV-S4: if we have a terminal state, ignore non-terminal stale data
      if (record !== undefined && record.terminalState !== null) {
        const terminal = record.terminalState;
        if (terminal !== undefined && !isTerminalJobState(state)) {
          // Stale squeue data — ignore, return the terminal state
          return this.#updateJobState(record, terminal, 'squeue', true);
        }
      }

      if (record !== undefined) {
        return this.#updateJobState(record, state, 'squeue', false);
      }

      // Job not in cache — construct from squeue result
      return this.#constructJobFromState(jobId, state);
    }

    // squeue empty or failed — try sacct (historical)
    const sacctResult = await this.#runSacct(jobIdNumber);

    if (sacctResult !== null) {
      const state = sacctResult;

      if (record !== undefined) {
        return this.#updateJobState(record, state, 'sacct', false);
      }

      return this.#constructJobFromState(jobId, state);
    }

    // Not in squeue or sacct — Job does not exist
    throw new JobNotFoundError({
      userMessage: `Job ${jobIdNumber} does not exist.`,
      internalDetails: `Job ${jobIdNumber} not found in squeue or sacct`,
      recoveryHint: 'Verify the JobID.',
      specRef: 'api-contracts.md §2; invariants.md INV-S3',
    });
  }

  // ========================================================================
  // queryJobsByUser
  // ========================================================================

  async queryJobsByUser(username: string): Promise<Job[]> {
    // Use ShellExecutor for the simple squeue -u command (per task:
    // "ShellExecutor for simple command parsing")
    const command = `squeue -u ${username} --format=%i,%T`;
    let result: ShellResult;
    try {
      result = await this.#shellExecutor.execute(command, {
        timeout: this.#config.commandTimeoutMs,
      });
    } catch (error) {
      throw new SchedulerUnavailable({
        command,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (isSlurmUnavailable(result)) {
      throw new SchedulerUnavailable({
        command,
        error: result.stderr,
      });
    }

    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      throw new SchedulerUnavailable({
        command,
        error: result.stderr,
      });
    }

    const entries = parseSqueueOutput(result.stdout);
    return entries.map((e) => {
      const jobId = jobIdFromNumber(e.jobId);
      const record = this.#jobs.get(e.jobId);
      if (record !== undefined) {
        return this.#updateJobState(record, e.state, 'squeue', false);
      }
      return this.#constructJobFromState(jobId, e.state);
    });
  }

  // ========================================================================
  // cancelJob
  // ========================================================================

  async cancelJob(jobId: JobId): Promise<void> {
    const jobIdNumber = jobId as number;
    let result: ShellResult;
    try {
      result = await this.#subprocessRunner.execute(
        'scancel',
        [String(jobIdNumber)],
        { timeout: this.#config.commandTimeoutMs },
      );
    } catch (error) {
      throw new SchedulerUnavailable({
        command: 'scancel',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (isSlurmUnavailable(result)) {
      throw new SchedulerUnavailable({
        command: 'scancel',
        error: result.stderr,
      });
    }

    if (isJobNotFoundResult(result)) {
      throw new JobNotFoundError({
        userMessage: `Job ${jobIdNumber} does not exist.`,
        internalDetails: `scancel: ${result.stderr.trim()}`,
        recoveryHint: 'Verify the JobID.',
        specRef: 'api-contracts.md §2; invariants.md INV-S3',
      });
    }

    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      throw new SchedulerUnavailable({
        command: 'scancel',
        error: result.stderr,
      });
    }

    // Mark the Job as CANCELLED if it's in our cache (INV-S4)
    const record = this.#jobs.get(jobIdNumber);
    if (record !== undefined) {
      this.#updateJobState(record, 'CANCELLED', 'squeue', false);
    }

    this.#emitJobCancelled(jobId, 'user');
  }

  // ========================================================================
  // reconcileViaSacct
  // ========================================================================

  async reconcileViaSacct(jobIds: JobId[]): Promise<Job[]> {
    if (jobIds.length === 0) {
      return [];
    }

    const idStrings = jobIds.map((id) => String(id as number));
    let result: ShellResult;
    try {
      result = await this.#subprocessRunner.execute(
        'sacct',
        [
          '-j',
          idStrings.join(','),
          '--format=JobID,State,Elapsed,ExitCode',
          '--noheader',
          '--parsable2',
        ],
        { timeout: this.#config.commandTimeoutMs },
      );
    } catch (error) {
      throw new SchedulerUnavailable({
        command: 'sacct',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (isSlurmUnavailable(result)) {
      throw new SchedulerUnavailable({
        command: 'sacct',
        error: result.stderr,
      });
    }

    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      throw new SchedulerUnavailable({
        command: 'sacct',
        error: result.stderr,
      });
    }

    const entries = parseSacctOutput(result.stdout);
    const jobs: Job[] = [];
    for (const entry of entries) {
      const jobId = jobIdFromNumber(entry.jobId);
      const record = this.#jobs.get(entry.jobId);
      if (record !== undefined) {
        jobs.push(this.#updateJobState(record, entry.state, 'sacct', false));
      } else {
        jobs.push(this.#constructJobFromState(jobId, entry.state));
      }
    }
    return jobs;
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Runs `squeue -j <id> --format=%i,%T` and returns the JobState,
   * or null if squeue returns no output (Job not in queue — try
   * sacct) or throws SchedulerUnavailable.
   */
  async #runSqueue(jobIdNumber: number): Promise<JobState | null> {
    let result: ShellResult;
    try {
      result = await this.#subprocessRunner.execute(
        'squeue',
        ['-j', String(jobIdNumber), '--format=%i,%T'],
        { timeout: this.#config.commandTimeoutMs },
      );
    } catch (error) {
      throw new SchedulerUnavailable({
        command: 'squeue',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (isSlurmUnavailable(result)) {
      // Emit JobUnknown event
      const jobId = jobIdFromNumber(jobIdNumber);
      this.#emitJobUnknown(jobId, result.stderr);
      throw new SchedulerUnavailable({
        command: 'squeue',
        error: result.stderr,
      });
    }

    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      // squeue failed but not a connection error — treat as unavailable
      this.#emitJobUnknown(jobIdFromNumber(jobIdNumber), result.stderr);
      throw new SchedulerUnavailable({
        command: 'squeue',
        error: result.stderr,
      });
    }

    const entries = parseSqueueOutput(result.stdout);
    if (entries.length === 0) {
      return null; // Job not in active queue — try sacct
    }
    const entry = entries[0];
    if (entry === undefined) {
      return null;
    }
    return entry.state;
  }

  /**
   * Runs `sacct -j <id> --format=JobID,State,Elapsed,ExitCode
   * --noheader --parsable2` and returns the JobState, or null if
   * sacct returns no output (Job not found).
   */
  async #runSacct(jobIdNumber: number): Promise<JobState | null> {
    let result: ShellResult;
    try {
      result = await this.#subprocessRunner.execute(
        'sacct',
        [
          '-j',
          String(jobIdNumber),
          '--format=JobID,State,Elapsed,ExitCode',
          '--noheader',
          '--parsable2',
        ],
        { timeout: this.#config.commandTimeoutMs },
      );
    } catch (error) {
      throw new SchedulerUnavailable({
        command: 'sacct',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (isSlurmUnavailable(result)) {
      throw new SchedulerUnavailable({
        command: 'sacct',
        error: result.stderr,
      });
    }

    if (result.exitOutcome.kind === 'exit_code' && result.exitOutcome.code !== 0) {
      throw new SchedulerUnavailable({
        command: 'sacct',
        error: result.stderr,
      });
    }

    const entries = parseSacctOutput(result.stdout);
    if (entries.length === 0) {
      return null;
    }
    const entry = entries[0];
    if (entry === undefined) {
      return null;
    }
    return entry.state;
  }

  /**
   * Updates a Job's state in the cache and emits a JobStateChanged
   * event if the state actually changed.
   *
   * INV-S4: once a terminal state is observed, it is final. If
   * `stale` is true (the state came from stale squeue data while a
   * terminal state is already known), the stale state is ignored.
   */
  #updateJobState(
    record: InternalJobRecord,
    newState: JobState,
    source: 'squeue' | 'sacct',
    stale: boolean,
  ): Job {
    if (stale) {
      // INV-S4: terminal state is final, ignore stale non-terminal
      return record.job;
    }

    const oldState = record.job.state;

    // Update the Job with the new state
    const updatedJob: Job = {
      ...record.job,
      state: newState,
      terminalState: isTerminalJobState(newState) ? newState : record.terminalState,
      completedAt: isTerminalJobState(newState) ? new Date() : record.job.completedAt,
    };
    record.job = updatedJob;

    if (oldState !== newState) {
      this.#emitJobStateChanged(updatedJob.jobId, oldState, newState, source);
    }

    return updatedJob;
  }

  /**
   * Constructs a Job from a JobId and State when the Job is not in
   * the cache (submitted in a previous Session). The ResourceRequest
   * is unknown — a default is used.
   */
  #constructJobFromState(jobId: JobId, state: JobState): Job {
    const now = new Date();
    const job: Job = {
      jobId,
      userId: this.#userId,
      resourceRequest: {
        nodes: 0,
        coresPerNode: 0,
        memory: '0',
        wallTime: '00:00:00',
        partition: 'unknown',
        qos: 'unknown',
      },
      state,
      terminalState: isTerminalJobState(state) ? state : null,
      submittedAt: now,
      completedAt: isTerminalJobState(state) ? now : null,
    };

    this.#jobs.set(jobId as number, {
      job,
      terminalState: job.terminalState,
    });

    return job;
  }

  // ========================================================================
  // Event emission
  // ========================================================================

  #emitJobSubmitted(jobId: JobId, resourceRequest: ResourceRequest): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'job_submitted',
        jobId,
        resourceRequestHash: JSON.stringify(resourceRequest),
        timestamp: new Date(),
      });
    }
  }

  #emitJobStateChanged(
    jobId: JobId,
    previousState: JobState,
    newState: JobState,
    source: 'squeue' | 'sacct',
  ): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'job_state_changed',
        jobId,
        previousState,
        newState,
        source,
        timestamp: new Date(),
      });
    }
  }

  #emitJobCancelled(jobId: JobId, by: 'user' | 'agent' | 'system'): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'job_cancelled',
        jobId,
        by,
        timestamp: new Date(),
      });
    }
  }

  #emitJobUnknown(jobId: JobId, reason: string): void {
    if (this.#onEvent) {
      this.#onEvent({
        kind: 'job_unknown',
        jobId,
        reason,
        retryAfterMs: this.#config.initialPollIntervalMs,
        timestamp: new Date(),
      });
    }
  }
}

// Re-export StaleQueueData for completeness (used in FM-S3 handling
// documentation; the service handles stale data internally without
// throwing, but the error type is available for callers that want to
// explicitly detect stale data).
export { StaleQueueData };
