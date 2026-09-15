/**
 * SLURM output parser.
 *
 * Parses sbatch, squeue, and sacct CLI output into cera's JobId
 * and JobState types. The parser is the foundation for INV-S1:
 * states are taken directly from SLURM output, never inferred from
 * file existence or elapsed time.
 *
 * SLURM-only (R8, ADR-004). No scheduler abstraction.
 *
 * Supported output formats:
 * - sbatch:  "Submitted batch job 4827365"
 * - squeue:  "4827365,RUNNING" (--format=%i,%T)
 * - sacct:   "4827365|COMPLETED|168:00:00|0:0" (--parsable2)
 *
 * Spec: api-contracts.md §2; invariants.md INV-S1, INV-S3;
 * features/job-management.feature; ADR-004.
 */

import type { JobState } from '../types';

// ============================================================================
// State string mapping
// ============================================================================

/**
 * Maps SLURM state strings (both full and abbreviated forms) to
 * cera's JobState type.
 *
 * Full names (from `%T` format): PENDING, RUNNING, COMPLETED, FAILED,
 * TIMEOUT, CANCELLED, OUT_OF_MEMORY, NODE_FAIL, UNKNOWN.
 *
 * Abbreviated names (from `%t` format): PD, R, CD, F, TO, CA, OOM, NF.
 *
 * Spec: invariants.md INV-S1; value-objects.ts JobState.
 */
const SLURM_STATE_MAP: Readonly<Record<string, JobState>> = {
  // Full names
  PENDING: 'PENDING',
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  OUT_OF_MEMORY: 'OUT_OF_MEMORY',
  NODE_FAIL: 'NODE_FAIL',
  UNKNOWN: 'UNKNOWN',
  // Abbreviated names (SLURM %t format)
  PD: 'PENDING',
  R: 'RUNNING',
  CG: 'RUNNING', // COMPLETING — treated as RUNNING (not terminal)
  CD: 'COMPLETED',
  F: 'FAILED',
  TO: 'TIMEOUT',
  CA: 'CANCELLED',
  OOM: 'OUT_OF_MEMORY',
  NF: 'NODE_FAIL',
};

/**
 * Parses a SLURM state string into cera's JobState.
 *
 * @throws {Error} if the state string is not recognized.
 *
 * Spec: invariants.md INV-S1 (state from Scheduler output).
 */
export function parseSLURMStateString(stateStr: string): JobState {
  const trimmed = stateStr.trim();
  if (trimmed === '') {
    throw new Error(`Cannot parse empty SLURM state string`);
  }
  // SLURM states may have suffixes like "CANCELLED by 1001" —
  // take the first token for matching.
  const firstToken = trimmed.split(/\s+/)[0];
  if (firstToken === undefined) {
    throw new Error(`Cannot parse SLURM state string: '${stateStr}'`);
  }
  const state = SLURM_STATE_MAP[firstToken.toUpperCase()];
  if (state === undefined) {
    throw new Error(`Unknown SLURM state: '${firstToken}'`);
  }
  return state;
}

// ============================================================================
// sbatch output parsing
// ============================================================================

/**
 * Parses the JobID from sbatch stdout.
 *
 * sbatch output format: "Submitted batch job 4827365"
 *
 * The JobID is assigned by the Scheduler (INV-S3). If sbatch does not
 * return a parseable JobID, the submission is treated as failed
 * (RejectedByScheduler, thrown by the caller).
 *
 * @returns The JobID as a positive integer.
 * @throws {Error} if the output is empty, doesn't match the expected
 *   format, or the JobID is not a positive integer.
 *
 * Spec: invariants.md INV-S3; features/job-management.feature
 * (Unique JobID assigned by Scheduler).
 */
export function parseSbatchOutput(stdout: string): number {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    throw new Error('sbatch produced no output');
  }
  const match = trimmed.match(/Submitted batch job (\d+)/);
  if (match === null || match[1] === undefined) {
    throw new Error(`Cannot parse JobID from sbatch output: '${trimmed}'`);
  }
  const jobId = Number.parseInt(match[1], 10);
  if (!Number.isInteger(jobId) || jobId <= 0) {
    throw new Error(`sbatch returned invalid JobID: ${match[1]}`);
  }
  return jobId;
}

// ============================================================================
// squeue output parsing
// ============================================================================

/**
 * A parsed squeue entry: JobID and State.
 */
export interface SqueueEntry {
  readonly jobId: number;
  readonly state: JobState;
}

/**
 * Parses squeue output in `--format=%i,%T` format.
 *
 * Output format: one line per Job, comma-separated:
 *   4827365,RUNNING
 *   4827366,PENDING
 *
 * Blank lines are skipped. Each line must have exactly two fields
 * (JobID and State). The JobID must be a positive integer. The State
 * must be a recognized SLURM state.
 *
 * @returns Array of parsed entries (empty if input is empty).
 * @throws {Error} on any malformed line.
 *
 * Spec: invariants.md INV-S1; features/job-management.feature
 * (Query running Job state, Query multiple Jobs for a User).
 */
export function parseSqueueOutput(stdout: string): SqueueEntry[] {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  const lines = trimmed.split('\n');
  const entries: SqueueEntry[] = [];
  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (lineTrimmed === '') {
      continue;
    }
    const parts = lineTrimmed.split(',');
    if (parts.length !== 2 || parts[0] === undefined || parts[1] === undefined) {
      throw new Error(`Malformed squeue line (expected JobID,State): '${lineTrimmed}'`);
    }
    const jobId = Number.parseInt(parts[0].trim(), 10);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new Error(`squeue returned invalid JobID: '${parts[0]}'`);
    }
    const state = parseSLURMStateString(parts[1].trim());
    entries.push({ jobId, state });
  }
  return entries;
}

// ============================================================================
// sacct output parsing
// ============================================================================

/**
 * A parsed sacct entry: JobID, State, Elapsed, ExitCode.
 */
export interface SacctEntry {
  readonly jobId: number;
  readonly state: JobState;
  readonly elapsed: string;
  readonly exitCode: string;
}

/**
 * Parses sacct output in `--parsable2` format (pipe-delimited).
 *
 * Output format:
 *   4827365|COMPLETED|168:00:00|0:0
 *   4827365.batch|COMPLETED|168:00:00|0:0
 *   4827365.extern|COMPLETED|00:00:01|0:0
 *
 * Only the main Job line (without `.batch`/`.extern` suffix) is
 * parsed — step lines are skipped. Each main Job line must have
 * exactly 4 fields: JobID, State, Elapsed, ExitCode.
 *
 * @returns Array of parsed entries (empty if input is empty).
 * @throws {Error} on any malformed main Job line.
 *
 * Spec: invariants.md INV-S1, INV-S4; features/job-management.feature
 * (Query completed Job state with sacct, reconciliation scenarios).
 */
export function parseSacctOutput(stdout: string): SacctEntry[] {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  const lines = trimmed.split('\n');
  const entries: SacctEntry[] = [];
  for (const line of lines) {
    const lineTrimmed = line.trim();
    if (lineTrimmed === '') {
      continue;
    }
    // Skip step lines (JobID contains a dot, e.g., 4827365.batch).
    // Only the main Job line (no dot) is relevant.
    const firstField = lineTrimmed.split('|')[0];
    if (firstField === undefined || firstField.includes('.')) {
      continue;
    }
    const parts = lineTrimmed.split('|');
    if (parts.length < 4) {
      throw new Error(
        `Malformed sacct line (expected JobID|State|Elapsed|ExitCode): '${lineTrimmed}'`,
      );
    }
    const jobIdStr = parts[0];
    const stateStr = parts[1];
    const elapsed = parts[2];
    const exitCode = parts[3];
    if (
      jobIdStr === undefined ||
      stateStr === undefined ||
      elapsed === undefined ||
      exitCode === undefined
    ) {
      throw new Error(`Malformed sacct line: '${lineTrimmed}'`);
    }
    const jobId = Number.parseInt(jobIdStr.trim(), 10);
    if (!Number.isInteger(jobId) || jobId <= 0) {
      throw new Error(`sacct returned invalid JobID: '${jobIdStr}'`);
    }
    const state = parseSLURMStateString(stateStr.trim());
    entries.push({
      jobId,
      state,
      elapsed: elapsed.trim(),
      exitCode: exitCode.trim(),
    });
  }
  return entries;
}
