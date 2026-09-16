/**
 * SubprocessRunner implementation via FirecREST (F-INV-6).
 *
 * FirecREST has no direct command execution endpoint, so the
 * SubprocessRunner — like the ShellExecutor — submits commands as
 * SLURM Jobs via POST /compute/{system}/jobs.
 *
 * The `spawn` method returns a `SubprocessHandle` that wraps the
 * FirecREST Job. The `pid` is the FirecREST Job ID. The `stdout`
 * and `stderr` async iterables emit the Job's output when it reaches
 * a terminal state (FirecREST does not provide streaming during
 * execution). The `kill` method cancels the Job via
 * DELETE /compute/{system}/jobs/{jobId}. The `wait` method polls
 * until terminal and returns a `ShellResult`.
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
  SubprocessHandle,
  SubprocessOptions,
  SubprocessRunner,
  ShellResult,
} from '../dsh-adapter/types';
import type { JobState } from '../types';
import { isTerminalJobState } from '../types/value-objects';
import { buildJobScript } from './job-script-builder';
import { deriveExitOutcome, UENV_SPECS_KEY } from './shell-executor';
export { UENV_SPECS_KEY } from './shell-executor';

// ============================================================================
// Config
// ============================================================================

/**
 * Configuration for the FirecrestSubprocessRunner.
 */
export interface FirecrestSubprocessRunnerConfig {
  /** Polling interval for Job state queries (ms). Default: 5000. */
  readonly pollIntervalMs?: number;
}

// ============================================================================
// FirecrestSubprocessHandle
// ============================================================================

/**
 * A SubprocessHandle that wraps a FirecREST Job. The `pid` is the
 * FirecREST Job ID. The `stdout` and `stderr` async iterables emit
 * the Job's full output when it reaches a terminal state (not
 * streaming during execution, since FirecREST doesn't provide
 * streaming).
 *
 * The `kill` method cancels the Job via
 * DELETE /compute/{system}/jobs/{jobId}. The `wait` method polls
 * until terminal and returns a `ShellResult`.
 *
 * Spec: specs/firecrest/invariants.md F-INV-6; ADR-011.
 */
class FirecrestSubprocessHandle implements SubprocessHandle {
  #client: FirecrestClient;
  #systemName: string;
  #jobId: number;
  #pollIntervalMs: number;
  #killed = false;
  #terminalJob: FirecrestJob | null = null;

  constructor(
    client: FirecrestClient,
    systemName: string,
    jobId: number,
    pollIntervalMs: number,
  ) {
    this.#client = client;
    this.#systemName = systemName;
    this.#jobId = jobId;
    this.#pollIntervalMs = pollIntervalMs;
  }

  get pid(): number {
    return this.#jobId;
  }

  get stdout(): AsyncIterable<string> {
    return this.#createStream('stdout');
  }

  get stderr(): AsyncIterable<string> {
    return this.#createStream('stderr');
  }

  /**
   * Creates an async iterable that emits the Job's output (stdout
   * or stderr) once the Job reaches a terminal state. If the Job is
   * already terminal (from `wait()`), emits immediately.
   */
  #createStream(field: 'stdout' | 'stderr'): AsyncIterable<string> {
    const readTerminalJob = (): FirecrestJob | null => this.#terminalJob;
    const pollUntilTerminal = this.#pollUntilTerminal.bind(this);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        let job = readTerminalJob();
        if (job === null) {
          job = await pollUntilTerminal();
        }
        const output = field === 'stdout' ? (job.stdout ?? '') : (job.stderr ?? '');
        if (output.length > 0) {
          yield output;
        }
      },
    };
  }

  async kill(_signal?: string): Promise<void> {
    if (this.#killed) {
      return;
    }
    this.#killed = true;
    await this.#client.delete(
      `/compute/${this.#systemName}/jobs/${this.#jobId}`,
    );
  }

  async wait(): Promise<ShellResult> {
    if (this.#terminalJob !== null) {
      return this.#toShellResult(this.#terminalJob);
    }
    const job = await this.#pollUntilTerminal();
    return this.#toShellResult(job);
  }

  async #pollUntilTerminal(): Promise<FirecrestJob> {
    if (this.#terminalJob !== null) {
      return this.#terminalJob;
    }

    const path = `/compute/${this.#systemName}/jobs/${this.#jobId}`;
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
        this.#terminalJob = firecrestJob;
        return firecrestJob;
      }

      await this.#sleep(this.#pollIntervalMs);
    }
  }

  #toShellResult(job: FirecrestJob): ShellResult {
    return {
      stdout: job.stdout ?? '',
      stderr: job.stderr ?? '',
      exitOutcome: deriveExitOutcome(job),
    };
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// FirecrestSubprocessRunner
// ============================================================================

/**
 * Implements SubprocessRunner by submitting commands as SLURM Jobs
 * via FirecREST (F-INV-6). All operations are parallel — there is
 * no synchronous command execution path.
 *
 * The `execute` method builds a command from `command + args.join(' ')`,
 * wraps it in a Job script (with optional `uenv start` prefix for
 * F-INV-5), submits via POST /compute/{system}/jobs, and polls until
 * terminal.
 *
 * The `spawn` method returns a `SubprocessHandle` that wraps the
 * FirecREST Job, supporting `wait()`, `kill()`, and `stdout`/`stderr`
 * async iterables.
 *
 * Spec: specs/firecrest/invariants.md F-INV-5, F-INV-6;
 * specs/firecrest/features/firecrest-backend.feature;
 * ADR-011.
 */
export class FirecrestSubprocessRunner implements SubprocessRunner {
  #client: FirecrestClient;
  #systemName: string;
  #pollIntervalMs: number;

  constructor(
    client: FirecrestClient,
    systemName: string,
    config?: FirecrestSubprocessRunnerConfig,
  ) {
    this.#client = client;
    this.#systemName = systemName;
    this.#pollIntervalMs = config?.pollIntervalMs ?? 5000;
  }

  async execute(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): Promise<ShellResult> {
    // Build the full command from command + args
    const fullCommand = args.length > 0
      ? `${command} ${args.join(' ')}`
      : command;

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
    const jobScript = buildJobScript(fullCommand, {
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
    const handle = new FirecrestSubprocessHandle(
      this.#client,
      this.#systemName,
      jobId,
      this.#pollIntervalMs,
    );
    return handle.wait();
  }

  spawn(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): SubprocessHandle {
    // Build the full command from command + args
    const fullCommand = args.length > 0
      ? `${command} ${args.join(' ')}`
      : command;

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
    const jobScript = buildJobScript(fullCommand, {
      uenvSpecs,
      env: Object.keys(regularEnv).length > 0 ? regularEnv : undefined,
    });

    // Submit the Job synchronously (spawn is synchronous, but the
    // HTTP POST is async — we handle this with a synchronous wrapper)
    // Since spawn() must return synchronously, we submit the Job
    // asynchronously and return a handle that will resolve the
    // jobId once the POST completes.
    return new PendingFirecrestSubprocessHandle(
      this.#client,
      this.#systemName,
      this.#pollIntervalMs,
      this.#client.post<FirecrestJobSubmitResponse>(
        `/compute/${this.#systemName}/jobs`,
        { jobScript },
      ),
    );
  }
}

// ============================================================================
// PendingFirecrestSubprocessHandle
// ============================================================================

/**
 * A SubprocessHandle for a Job that has been submitted but whose
 * jobId is not yet known (the POST is still in flight). Once the
 * POST completes, the handle delegates to a FirecrestSubprocessHandle.
 *
 * Since FirecREST has no streaming, the stdout/stderr async
 * iterables wait for the POST to complete before polling.
 *
 * This is necessary because `spawn()` must return synchronously,
 * but the HTTP POST to submit the Job is asynchronous.
 */
class PendingFirecrestSubprocessHandle implements SubprocessHandle {
  #client: FirecrestClient;
  #systemName: string;
  #pollIntervalMs: number;
  #submitPromise: Promise<{ statusCode: number; body: FirecrestJobSubmitResponse }>;
  #resolvedHandle: FirecrestSubprocessHandle | null = null;
  #resolveError: Error | null = null;

  constructor(
    client: FirecrestClient,
    systemName: string,
    pollIntervalMs: number,
    submitPromise: Promise<{ statusCode: number; body: FirecrestJobSubmitResponse }>,
  ) {
    this.#client = client;
    this.#systemName = systemName;
    this.#pollIntervalMs = pollIntervalMs;
    this.#submitPromise = submitPromise;

    // Resolve the handle immediately
    submitPromise
      .then((response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          this.#resolveError = new Error(
            `Job submission failed with status ${response.statusCode}: ` +
            `${JSON.stringify(response.body)}`,
          );
          return;
        }
        const submitted = response.body;
        if (submitted === undefined || submitted === null || typeof submitted !== 'object') {
          this.#resolveError = new Error('Job submission response is missing job data');
          return;
        }
        const jobId = (submitted as FirecrestJobSubmitResponse).jobId;
        if (typeof jobId !== 'number' || !Number.isFinite(jobId)) {
          this.#resolveError = new Error(`Job submission response has invalid jobId: ${String(jobId)}`);
          return;
        }
        this.#resolvedHandle = new FirecrestSubprocessHandle(
          this.#client,
          this.#systemName,
          jobId,
          this.#pollIntervalMs,
        );
      })
      .catch((error: unknown) => {
        this.#resolveError = error instanceof Error
          ? error
          : new Error(String(error));
      });
  }

  get pid(): number {
    // Return 0 if the jobId is not yet known (the POST is still in flight)
    return this.#resolvedHandle?.pid ?? 0;
  }

  get stdout(): AsyncIterable<string> {
    const getResolvedHandle = this.#getResolvedHandle.bind(this);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        const handle = await getResolvedHandle();
        yield* handle.stdout;
      },
    };
  }

  get stderr(): AsyncIterable<string> {
    const getResolvedHandle = this.#getResolvedHandle.bind(this);
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<string> {
        const handle = await getResolvedHandle();
        yield* handle.stderr;
      },
    };
  }

  async kill(_signal?: string): Promise<void> {
    const handle = await this.#getResolvedHandle();
    await handle.kill(_signal);
  }

  async wait(): Promise<ShellResult> {
    const handle = await this.#getResolvedHandle();
    return handle.wait();
  }

  async #getResolvedHandle(): Promise<FirecrestSubprocessHandle> {
    if (this.#resolveError !== null) {
      throw this.#resolveError;
    }
    if (this.#resolvedHandle !== null) {
      return this.#resolvedHandle;
    }
    // Wait for the submit promise to resolve
    await this.#submitPromise;
    if (this.#resolveError !== null) {
      throw this.#resolveError;
    }
    if (this.#resolvedHandle === null) {
      throw new Error('Job submission did not produce a handle');
    }
    return this.#resolvedHandle;
  }
}
