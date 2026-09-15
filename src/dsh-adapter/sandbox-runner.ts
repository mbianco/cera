/**
 * SandboxRunner implementation.
 *
 * Wraps dsh's ctx.sandbox extension point. This is the ONLY code in
 * cera that calls ctx.sandbox directly. Domain modules use the
 * SandboxRunner interface instead.
 *
 * The sandbox provides process confinement with restricted filesystem
 * paths and optional network access control. Used for executing
 * legacy binaries that require isolation.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */

import type { DshContext, DshRawProcessHandle } from './context';
import { toExitOutcome, translateDshError } from './internal';
import type {
  SandboxOptions,
  ShellResult,
  SubprocessHandle,
  SandboxRunner,
} from './types';

/**
 * Wraps a raw dsh sandbox process handle, translating wait() to
 * return a ShellResult. Same wrapper as SubprocessHandleWrapper —
 * the raw handle shape is identical between subprocess and sandbox.
 */
class SandboxHandleWrapper implements SubprocessHandle {
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
      translateDshError(error, 'ctx.sandbox', 'kill');
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
      translateDshError(error, 'ctx.sandbox', 'wait');
    }
  }
}

export class SandboxRunnerImpl implements SandboxRunner {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  async execute(
    command: string,
    options?: SandboxOptions,
  ): Promise<ShellResult> {
    try {
      const raw = await this.#ctx.sandbox.execute(command, options);
      return {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitOutcome: toExitOutcome(raw),
      };
    } catch (error) {
      translateDshError(error, 'ctx.sandbox', 'execute');
    }
  }

  spawn(
    command: string,
    args: string[],
    options?: SandboxOptions,
  ): SubprocessHandle {
    try {
      const raw = this.#ctx.sandbox.spawn(command, args, options);
      return new SandboxHandleWrapper(raw);
    } catch (error) {
      translateDshError(error, 'ctx.sandbox', 'spawn');
    }
  }
}
