/**
 * Test helpers for the scheduling module.
 *
 * Provides mock SubprocessRunner and ShellExecutor factories and mock
 * SLURM output strings so tests can verify parsing, invariant
 * enforcement, and failure modes without a real SLURM controller.
 *
 * Spec: build-phases.md Phase 2 (Tier 1 — unit tests with mock SLURM).
 */

import { vi } from 'vitest';
import type {
  ShellResult,
  ShellExecutor,
  SubprocessRunner,
  SubprocessOptions,
} from '../../src/dsh-adapter/types';
import type {
  Job,
  JobId,
  ResourceRequest,
  UserId,
  ExitOutcome,
  JobState,
} from '../../src/types';

// ============================================================================
// SLURM output string constants
// ============================================================================

/**
 * sbatch success output: "Submitted batch job 4827365".
 * Spec: task description (sbatch stdout format).
 */
export const SBATCH_SUCCESS_OUTPUT = 'Submitted batch job 4827365\n';

/**
 * sbatch rejection output (non-zero exit code).
 */
export const SBATCH_REJECTION_STDERR =
  'sbatch: error: Batch job submission failed: Invalid qos specification';

/**
 * squeue active job output: "JobID,State" format.
 * Spec: squeue -j <id> --format=%i,%T
 */
export const SQUEUE_RUNNING_OUTPUT = '4827365,RUNNING\n';
export const SQUEUE_PENDING_OUTPUT = '4827366,PENDING\n';
export const SQUEUE_COMPLETED_OUTPUT = '4827367,COMPLETED\n';

/**
 * squeue multiple jobs output for a user.
 * Spec: squeue -u <username> --format=%i,%T
 */
export const SQUEUE_MULTI_USER_OUTPUT = [
  '4827365,RUNNING',
  '4827366,PENDING',
  '4827367,COMPLETED',
].join('\n') + '\n';

/**
 * squeue error output when SLURM is unreachable.
 * Spec: FM-S2, job-management.feature "Scheduler daemon unavailable".
 */
export const SQUEUE_UNAVAILABLE_STDERR =
  'slurm_load_jobs error: Unable to contact slurm controller';

/**
 * sacct output for a completed Job (--parsable2 format, | delimited).
 * Spec: sacct -j <id> --format=JobID,State,Elapsed,ExitCode --noheader --parsable2
 *
 * Note: sacct returns multiple lines for a single Job (main + batch +
 * extern steps). Only the main Job line (without .batch/.extern suffix)
 * is relevant.
 */
export const SACCT_COMPLETED_OUTPUT = [
  '4827365|COMPLETED|168:00:00|0:0',
  '4827365.batch|COMPLETED|168:00:00|0:0',
  '4827365.extern|COMPLETED|00:00:01|0:0',
].join('\n') + '\n';

export const SACCT_TIMEOUT_OUTPUT = '4827366|TIMEOUT|24:00:00|0:15\n';
export const SACCT_OUT_OF_MEMORY_OUTPUT = '4827368|OUT_OF_MEMORY|12:30:00|0:9\n';
export const SACCT_NODE_FAIL_OUTPUT = '4827369|NODE_FAIL|08:15:00|0:0\n';
export const SACCT_FAILED_OUTPUT = '4827370|FAILED|02:00:00|2:0\n';
export const SACCT_CANCELLED_OUTPUT = '4827371|CANCELLED|00:05:00|0:0\n';

/**
 * sacct output for multiple Jobs (reconciliation).
 */
export const SACCT_MULTI_OUTPUT = [
  '4827365|COMPLETED|168:00:00|0:0',
  '4827366|TIMEOUT|24:00:00|0:15',
  '4827367|CANCELLED|00:05:00|0:0',
].join('\n') + '\n';

/**
 * scancel error output for non-existent Job.
 */
export const SCANCEL_NOT_FOUND_STDERR = 'scancel: error: Job ID 9999999 not found';

// ============================================================================
// Mock ShellResult factory
// ============================================================================

/**
 * Creates a mock ShellResult with sensible defaults.
 */
export function createMockShellResult(
  overrides: Partial<ShellResult> = {},
): ShellResult {
  return {
    stdout: '',
    stderr: '',
    exitOutcome: { kind: 'exit_code', code: 0 },
    ...overrides,
  };
}

// ============================================================================
// Mock SubprocessRunner factory
// ============================================================================

/**
 * A configurable mock SubprocessRunner. Each call to execute() looks
 * up the response based on the command and (optionally) args, falling
 * back to the default response.
 *
 * Usage:
 *   const runner = createMockSubprocessRunner({
 *     responses: [
 *       { match: 'sbatch', result: createMockShellResult({ stdout: SBATCH_SUCCESS_OUTPUT }) },
 *       { match: 'squeue', result: createMockShellResult({ stdout: SQUEUE_RUNNING_OUTPUT }) },
 *     ],
 *   });
 */
export interface MockResponse {
  /** Match the command string (startsWith or exact). */
  readonly match: string;
  /** The result to return for this command. */
  readonly result: ShellResult;
  /** If true, match exact command; otherwise startsWith. Default: false. */
  readonly exact?: boolean;
  /** Optional: also match on first arg (e.g., -j vs -u). */
  readonly firstArgMatch?: string;
}

export function createMockSubprocessRunner(
  overrides: {
    responses?: MockResponse[];
    defaultResult?: ShellResult;
  } = {},
): SubprocessRunner & {
  readonly calls: { command: string; args: readonly string[] }[];
} {
  const responses = overrides.responses ?? [];
  const defaultResult =
    overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string; args: readonly string[] }[] = [];

  const findResponse = (
    command: string,
    args: readonly string[],
  ): ShellResult => {
    for (const r of responses) {
      const cmdMatch = r.exact
        ? command === r.match
        : command.startsWith(r.match);
      if (!cmdMatch) continue;
      if (r.firstArgMatch !== undefined) {
        const firstArg = args[0];
        if (firstArg !== r.firstArgMatch) continue;
      }
      return r.result;
    }
    return defaultResult;
  };

  const runner = {
    execute: vi.fn(
      async (
        command: string,
        args: string[],
        _options?: SubprocessOptions,
      ): Promise<ShellResult> => {
        calls.push({ command, args });
        return findResponse(command, args);
      },
    ),
    spawn: vi.fn(),
    calls,
  };

  return runner;
}

// ============================================================================
// Mock ShellExecutor factory
// ============================================================================

/**
 * A configurable mock ShellExecutor for simple command strings.
 */
export function createMockShellExecutor(
  overrides: {
    responses?: { readonly match: string; readonly result: ShellResult }[];
    defaultResult?: ShellResult;
  } = {},
): ShellExecutor & {
  readonly calls: { command: string }[];
} {
  const responses = overrides.responses ?? [];
  const defaultResult =
    overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string }[] = [];

  const findResponse = (command: string): ShellResult => {
    for (const r of responses) {
      if (command.includes(r.match)) {
        return r.result;
      }
    }
    return defaultResult;
  };

  const executor = {
    execute: vi.fn(
      async (
        command: string,
        _options?: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string },
      ): Promise<ShellResult> => {
        calls.push({ command });
        return findResponse(command);
      },
    ),
    calls,
  };

  return executor;
}

// ============================================================================
// Job factory
// ============================================================================

/**
 * Creates a mock Job with sensible defaults. Uses branded ID
 * assertions — the real factory would be in scheduling-service.
 */
export function createMockJob(overrides: {
  jobId?: JobId;
  userId?: UserId;
  resourceRequest?: ResourceRequest;
  state?: JobState;
  terminalState?: JobState | null;
  caseId?: unknown;
  workflowId?: unknown;
  submittedAt?: Date;
  completedAt?: Date | null;
}): Job {
  return {
    jobId: overrides.jobId ?? (4827365 as JobId),
    userId: overrides.userId ?? ('cera_user' as UserId),
    resourceRequest: overrides.resourceRequest ?? createMockResourceRequest(),
    state: overrides.state ?? 'RUNNING',
    terminalState: overrides.terminalState ?? null,
    caseId: overrides.caseId as Job['caseId'],
    workflowId: overrides.workflowId as Job['workflowId'],
    submittedAt: overrides.submittedAt ?? new Date('2026-09-15T00:00:00Z'),
    completedAt: overrides.completedAt ?? null,
  };
}

/**
 * Creates a mock ResourceRequest matching the SLURM feature file.
 */
export function createMockResourceRequest(
  overrides: Partial<ResourceRequest> = {},
): ResourceRequest {
  return {
    nodes: 128,
    coresPerNode: 36,
    memory: '128GB',
    wallTime: '168:00:00',
    partition: 'normal',
    qos: 'default',
    ...overrides,
  };
}

/**
 * Creates a mock ExitOutcome.
 */
export function createMockExitOutcome(
  overrides: Partial<ExitOutcome> = {},
): ExitOutcome {
  return {
    kind: 'exit_code',
    code: 0,
    ...overrides,
  } as ExitOutcome;
}

// ============================================================================
// JobId factory (branded type assertion)
// ============================================================================

/**
 * Creates a JobId from a number. The real factory is in the SLURM
 * parser, which parses the JobID from sbatch output (INV-S3).
 *
 * Uses a type assertion because the brand symbol is private to
 * value-objects.ts. This is standard TypeScript practice for branded
 * types — the assertion is intentional and safe at runtime (the
 * brand is compile-time only).
 */
export function createJobId(n: number): JobId {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`JobId must be a positive integer, got: ${n}`);
  }
  return n as JobId;
}
