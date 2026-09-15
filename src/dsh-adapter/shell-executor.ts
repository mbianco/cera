/**
 * ShellExecutor implementation.
 *
 * Wraps dsh's ctx.shell extension point. This is the ONLY code in
 * cera that calls ctx.shell directly. Domain modules use the
 * ShellExecutor interface instead.
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */

import type { DshContext } from './context';
import { toExitOutcome, translateDshError } from './internal';
import type { ShellExecuteOptions, ShellExecutor, ShellResult } from './types';

export class ShellExecutorImpl implements ShellExecutor {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  async execute(
    command: string,
    options?: ShellExecuteOptions,
  ): Promise<ShellResult> {
    try {
      const raw = await this.#ctx.shell.execute(command, options);
      return {
        stdout: raw.stdout,
        stderr: raw.stderr,
        exitOutcome: toExitOutcome(raw),
      };
    } catch (error) {
      translateDshError(error, 'ctx.shell', 'execute');
    }
  }
}
