/**
 * JobBackend implementation.
 *
 * Wraps dsh's ctx.jobs extension point. This is the ONLY code in cera
 * that calls ctx.jobs directly. Domain modules use the JobBackend
 * interface instead.
 *
 * Note: This is for dsh's internal background work system, NOT for
 * SLURM Jobs. SLURM Jobs are submitted via the scheduling module
 * using SubprocessRunner for CLI access (sbatch, squeue, scancel,
 * sacct).
 *
 * Spec: api-contracts.md §1; ADR-005; module-graph.md §1.
 */

import type { DshContext } from './context';
import { toExitOutcomeFromJobStatus, translateDshError } from './internal';
import type { BackgroundWork, BackgroundWorkStatus, JobBackend } from './types';

export class JobBackendImpl implements JobBackend {
  #ctx: DshContext;
  constructor(ctx: DshContext) {
    this.#ctx = ctx;
  }

  async submit(work: BackgroundWork): Promise<string> {
    try {
      return await this.#ctx.jobs.submit({
        command: work.command,
        args: work.args,
        cwd: work.cwd,
        env: work.env,
        timeout: work.timeout,
      });
    } catch (error) {
      translateDshError(error, 'ctx.jobs', 'submit');
    }
  }

  async query(workId: string): Promise<BackgroundWorkStatus> {
    try {
      const raw = await this.#ctx.jobs.query(workId);
      return {
        workId: raw.workId,
        state: raw.state,
        exitOutcome: toExitOutcomeFromJobStatus(raw),
        stdout: raw.stdout,
        stderr: raw.stderr,
      };
    } catch (error) {
      translateDshError(error, 'ctx.jobs', 'query');
    }
  }

  async cancel(workId: string): Promise<void> {
    try {
      await this.#ctx.jobs.cancel(workId);
    } catch (error) {
      translateDshError(error, 'ctx.jobs', 'cancel');
    }
  }
}
