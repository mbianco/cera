/**
 * SubprocessRunner implementation.
 *
 * Wraps dsh's ctx.subprocess extension point. This is the ONLY code
 * in cera that calls ctx.subprocess directly. Domain modules use the
 * SubprocessRunner interface instead.
 *
 * The spawn() method returns a SubprocessHandle that wraps the raw
 * dsh process handle, translating wait() results to ShellResult.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */

import type { DshContext, DshRawProcessHandle } from './context';
import { toExitOutcome, translateDshError } from './internal';
import type {
  ShellResult,
  SubprocessHandle,
  SubprocessOptions,
  SubprocessRunner,
} from './types';

/**
 * Wraps a raw dsh process handle, translating wait() to return a
 * ShellResult with a proper ExitOutcome. The stdout/stderr streams
 * are passed through directly — they are already AsyncIterable<string>
 * and do not leak dsh types.
 */
class SubprocessHandleWrapper implements SubprocessHandle {
  #raw: DshRawProcessHandle;
  constructor(raw: DshRawProcessHandle) {
    this.#raw = raw;
  }

  get pid(): number {
    return this.#raw.pid;
  }

  get stdout(): AsyncIterable<string> {
    return this.#raw.stdout;
  }

  get stderr(): AsyncIterable<string> {
    return this.#raw.stderr;
  }

  async kill(signal?: string): Promise<void> {
    try {
      await this.#raw.kill(signal);
    } catch (error) {
      translateDshError(error, 'ctx.subprocess', 'kill');
    }
  }

  async wait(): Promise<ShellResult> {
    try {
      const raw = await this.#raw.wait();
      return {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitOutcome: toExitOutcome(raw),
      };
    } catch (error) {
      translateDshError(error, 'ctx.subprocess', 'wait');
    }
  }
}

export class SubprocessRunnerImpl implements SubprocessRunner {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  spawn(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): SubprocessHandle {
    try {
      const raw = this.#ctx.subprocess.spawn(command, args, options);
      return new SubprocessHandleWrapper(raw);
    } catch (error) {
      translateDshError(error, 'ctx.subprocess', 'spawn');
    }
  }

  async execute(
    command: string,
    args: string[],
    options?: SubprocessOptions,
  ): Promise<ShellResult> {
    try {
      const raw = await this.#ctx.subprocess.execute(command, args, options);
      return {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitOutcome: toExitOutcome(raw),
      };
    } catch (error) {
      translateDshError(error, 'ctx.subprocess', 'execute');
    }
  }
}
