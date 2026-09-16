/**
 * ShellExecutor implementation via FirecREST (F-INV-5, F-INV-6).
 *
 * Under the FirecREST backend, every ToolInvocation — regardless of
 * its declared executionModel — is submitted as a SLURM Job via
 * POST /compute/{system}/jobs (F-INV-6). There is no "run command
 * and wait" endpoint in FirecREST.
 *
 * uenv is loaded inside the Job script, not by cera directly
 * (F-INV-5). The uenv specs are passed through the `env` field of
 * ShellExecuteOptions using the `UENV_SPECS_KEY` key (comma-separated).
 *
 * Spec: specs/firecrest/invariants.md F-INV-5, F-INV-6;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */

import type {
  FirecrestClient,
  FirecrestJob,
  FirecrestJobSubmitResponse,
} from './types';
import type {
  ShellExecuteOptions,
  ShellExecutor,
  ShellResult,
} from '../dsh-adapter/types';
import type { ExitOutcome, JobState } from '../types';
import {
  isTerminalJobState,
} from '../types/value-objects';
import { buildJobScript } from './job-script-builder';

// ============================================================================
// Constants
// ============================================================================

/**
 * Key in ShellExecuteOptions.env that holds comma-separated uenv
 * specs (e.g., "cdo:2.0.5,python:3.11"). This key is NOT passed as
 * an `export` statement in the Job script — it is extracted and
 * used for `uenv start` commands (F-INV-5).
 */
export const UENV_SPECS_KEY = '__CERA_UENV_SPECS__';

// ============================================================================
// Config
// ============================================================================

/**
 * Configuration for the FirecrestShellExecutor.
 */
export interface FirecrestShellExecutorConfig {
  /** Polling interval for Job state queries (ms). Default: 5000. */
  readonly pollIntervalMs?: number;
}

// ============================================================================
// ExitOutcome derivation
// ============================================================================

/**
 * Derives an ExitOutcome from a FirecREST Job's terminal state and
 * exit code.
 *
 * - If `exitCode` is a number, uses `{ kind: 'exit_code', code }`.
 * - If `exitCode` is absent and state is `TIMEOUT`, uses SIGTERM.
 * - If `exitCode` is absent and state is `OUT_OF_MEMORY`, uses SIGKILL.
 * - Otherwise, uses a default exit code based on the state
 *   (0 for COMPLETED, 1 for FAILED/NODE_FAIL, 125 for CANCELLED).
 *
 * Spec: invariants.md INV-T2 (ExitOutcome is either exit code or
 * signal, never both, never neither).
 */
export function deriveExitOutcome(job: FirecrestJob): ExitOutcome {
  if (typeof job.exitCode === 'number') {
    return { kind: 'exit_code', code: job.exitCode };
  }

  const state = job.state as JobState;
  switch (state) {
    case 'TIMEOUT':
      return { kind: 'signal', name: 'SIGTERM', number: 15 };
    case 'OUT_OF_MEMORY':
      return { kind: 'signal', name: 'SIGKILL', number: 9 };
    case 'COMPLETED':
      return { kind: 'exit_code', code: 0 };
    case 'CANCELLED':
      return { kind: 'exit_code', code: 125 };
    case 'FAILED':
    case 'NODE_FAIL':
    default:
      return { kind: 'exit_code', code: 1 };
  }
}

// ============================================================================
// FirecrestShellExecutor
// ============================================================================

/**
 * Implements ShellExecutor by submitting commands as SLURM Jobs via
 * FirecREST (F-INV-6). All operations are parallel — there is no
 * synchronous command execution path.
 *
 * The command is wrapped in a Job script (with optional `uenv start`
 * prefix for F-INV-5), submitted via POST /compute/{system}/jobs,
 * and polled until a terminal state is reached. The ShellResult
 * (stdout, stderr, ExitOutcome) is derived from the Job's terminal
 * state and exit code.
 *
 * Spec: specs/firecrest/invariants.md F-INV-5, F-INV-6;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */
export class FirecrestShellExecutor implements ShellExecutor {
  #client: FirecrestClient;
  #systemName: string;
  #pollIntervalMs: number;

  constructor(
    client: FirecrestClient,
    systemName: string,
    config?: FirecrestShellExecutorConfig,
  ) {
    this.#client = client;
    this.#systemName = systemName;
    this.#pollIntervalMs = config?.pollIntervalMs ?? 5000;
  }

  async execute(
    command: string,
    options?: ShellExecuteOptions,
  ): Promise<ShellResult> {
    // Extract uenv specs from env (F-INV-5)
    const env = options?.env ?? {};
    const uenvSpecsStr = env[UENV_SPECS_KEY];
    const uenvSpecs = uenvSpecsStr !== undefined && uenvSpecsStr.length > 0
      ? uenvSpecsStr.split(',').filter((s) => s.length > 0)
      : undefined;

    // Extract regular env vars (excluding UENV_SPECS_KEY)
    const regularEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      if (key !== UENV_SPECS_KEY) {
        regularEnv[key] = value;
      }
    }

    // Build the Job script (F-INV-5: uenv is in the script, not by cera)
    const jobScript = buildJobScript(command, {
      uenvSpecs,
      env: Object.keys(regularEnv).length > 0 ? regularEnv : undefined,
    });

    // Submit the Job via POST /compute/{system}/jobs (F-INV-6)
    const submitResponse = await this.#client.post<FirecrestJobSubmitResponse>(
      `/compute/${this.#systemName}/jobs`,
      { jobScript },
    );

    if (submitResponse.statusCode < 200 || submitResponse.statusCode >= 300) {
      throw new Error(
        `Job submission failed with status ${submitResponse.statusCode}: ` +
        `${JSON.stringify(submitResponse.body)}`,
      );
    }

    const submitted = submitResponse.body;
    if (submitted === undefined || submitted === null || typeof submitted !== 'object') {
      throw new Error('Job submission response is missing job data');
    }

    const jobId = (submitted as FirecrestJobSubmitResponse).jobId;
    if (typeof jobId !== 'number' || !Number.isFinite(jobId)) {
      throw new Error(`Job submission response has invalid jobId: ${String(jobId)}`);
    }

    // Poll until terminal state (INV-S4)
    const terminalJob = await this.#pollUntilTerminal(jobId);

    // Derive ShellResult from the terminal Job
    return {
      stdout: terminalJob.stdout ?? '',
      stderr: terminalJob.stderr ?? '',
      exitOutcome: deriveExitOutcome(terminalJob),
    };
  }

  /**
   * Polls GET /compute/{system}/jobs/{jobId} until the Job reaches
   * a terminal state (INV-S4). Returns the terminal FirecrestJob.
   */
  async #pollUntilTerminal(jobId: number): Promise<FirecrestJob> {
    const path = `/compute/${this.#systemName}/jobs/${jobId}`;

    while (true) {
      const response = await this.#client.get<FirecrestJob>(path);

      if (response.statusCode < 200 || response.statusCode >= 300) {
        throw new Error(
          `Job poll failed with status ${response.statusCode}: ` +
          `${JSON.stringify(response.body)}`,
        );
      }

      const job = response.body;
      if (job === undefined || job === null || typeof job !== 'object') {
        throw new Error('Job poll response is missing job data');
      }

      const firecrestJob = job as FirecrestJob;
      const state = firecrestJob.state as JobState;

      if (isTerminalJobState(state)) {
        return firecrestJob;
      }

      // Wait before next poll
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
