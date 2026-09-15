/**
 * Unit tests for JobBackend adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.jobs (submit, query, cancel)
 * - BackgroundWork → dsh work format translation
 * - BackgroundWorkStatus translation (including ExitOutcome)
 * - ExitOutcome is null for non-terminal states
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * invariants.md INV-T2, INV-T5; ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import { JobBackendImpl } from '../../src/dsh-adapter/job-backend';
import type {
  BackgroundWork,
  BackgroundWorkStatus,
  JobBackend,
} from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockJobStatus,
} from './helpers';

describe('JobBackend', () => {
  describe('submit()', () => {
    it('delegates to ctx.jobs.submit with translated work', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.submit = vi.fn().mockResolvedValue('work-abc123');
      const backend = new JobBackendImpl(ctx);
      const work: BackgroundWork = {
        command: 'cdo',
        args: ['-timmean', 'in.nc', 'out.nc'],
        cwd: '/scratch',
        env: { CDO_PATH: '/opt/cdo' },
        timeout: 60000,
      };

      const workId = await backend.submit(work);

      expect(ctx.jobs.submit).toHaveBeenCalledWith({
        command: 'cdo',
        args: ['-timmean', 'in.nc', 'out.nc'],
        cwd: '/scratch',
        env: { CDO_PATH: '/opt/cdo' },
        timeout: 60000,
      });
      expect(workId).toBe('work-abc123');
    });

    it('submits work with only a command (minimal)', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.submit = vi.fn().mockResolvedValue('work-001');
      const backend = new JobBackendImpl(ctx);
      const work: BackgroundWork = { command: 'echo hello' };

      await backend.submit(work);

      expect(ctx.jobs.submit).toHaveBeenCalledWith({
        command: 'echo hello',
        args: undefined,
        cwd: undefined,
        env: undefined,
        timeout: undefined,
      });
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.submit = vi.fn().mockRejectedValue(new Error('dsh jobs error'));
      const backend = new JobBackendImpl(ctx);

      await expect(backend.submit({ command: 'cdo' })).rejects.toThrow(
        AdapterInternal,
      );
    });

    it('includes extension point and operation in error details', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.submit = vi.fn().mockRejectedValue(new Error('dsh jobs error'));
      const backend = new JobBackendImpl(ctx);

      try {
        await backend.submit({ command: 'cdo' });
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterInternal);
        const adapterError = error as AdapterInternal;
        expect(adapterError.internalDetails).toContain('ctx.jobs');
        expect(adapterError.internalDetails).toContain('submit');
      }
    });
  });

  describe('query()', () => {
    it('delegates to ctx.jobs.query with the work ID', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({ workId: 'work-001', state: 'running' }),
      );
      const backend = new JobBackendImpl(ctx);

      await backend.query('work-001');

      expect(ctx.jobs.query).toHaveBeenCalledWith('work-001');
    });

    it('returns BackgroundWorkStatus with translated fields', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({
          workId: 'work-001',
          state: 'completed',
          exitCode: 0,
          stdout: 'done',
          stderr: '',
        }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result).toEqual<BackgroundWorkStatus>({
        workId: 'work-001',
        state: 'completed',
        exitOutcome: { kind: 'exit_code', code: 0 },
        stdout: 'done',
        stderr: '',
      });
    });

    it('returns null exitOutcome for pending state', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({ state: 'pending' }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result.exitOutcome).toBeNull();
    });

    it('returns null exitOutcome for running state', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({ state: 'running' }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result.exitOutcome).toBeNull();
    });

    it('translates exit code for failed state', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({
          state: 'failed',
          exitCode: 1,
        }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 1 });
    });

    it('translates signal for terminated work (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({
          state: 'failed',
          exitCode: null,
          signalName: 'SIGKILL',
          signalNumber: 9,
        }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGKILL',
        number: 9,
      });
    });

    it('signal takes precedence over exit code (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({
          state: 'failed',
          exitCode: 137,
          signalName: 'SIGKILL',
          signalNumber: 9,
        }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGKILL',
        number: 9,
      });
    });

    it('returns exit_code: 0 for cancelled state', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({
          state: 'cancelled',
          exitCode: null,
          signalName: null,
        }),
      );
      const backend = new JobBackendImpl(ctx);

      const result = await backend.query('work-001');

      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('throws AdapterInternal when terminal state has no outcome (INV-T2)', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({
          state: 'completed',
          exitCode: null,
          signalName: null,
          signalNumber: null,
        }),
      );
      const backend = new JobBackendImpl(ctx);

      await expect(backend.query('work-001')).rejects.toThrow(AdapterInternal);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockRejectedValue(new Error('dsh error'));
      const backend = new JobBackendImpl(ctx);

      await expect(backend.query('work-001')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('cancel()', () => {
    it('delegates to ctx.jobs.cancel with the work ID', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.cancel = vi.fn().mockResolvedValue(undefined);
      const backend = new JobBackendImpl(ctx);

      await backend.cancel('work-001');

      expect(ctx.jobs.cancel).toHaveBeenCalledWith('work-001');
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.cancel = vi.fn().mockRejectedValue(new Error('dsh error'));
      const backend = new JobBackendImpl(ctx);

      await expect(backend.cancel('work-001')).rejects.toThrow(AdapterInternal);
    });

    it('includes extension point and operation in error details', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.cancel = vi.fn().mockRejectedValue(new Error('dsh error'));
      const backend = new JobBackendImpl(ctx);

      try {
        await backend.cancel('work-001');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterInternal);
        const adapterError = error as AdapterInternal;
        expect(adapterError.internalDetails).toContain('ctx.jobs');
        expect(adapterError.internalDetails).toContain('cancel');
      }
    });
  });

  describe('interface stability', () => {
    it('implements the JobBackend interface', () => {
      const ctx = createMockDshContext();
      const backend: JobBackend = new JobBackendImpl(ctx);

      expect(typeof backend.submit).toBe('function');
      expect(typeof backend.query).toBe('function');
      expect(typeof backend.cancel).toBe('function');
    });

    it('does not expose the ctx property', () => {
      const ctx = createMockDshContext();
      const backend = new JobBackendImpl(ctx);

      expect(backend).not.toHaveProperty('ctx');
    });

    it('BackgroundWorkStatus has cera types, not dsh types', async () => {
      const ctx = createMockDshContext();
      ctx.jobs.query = vi.fn().mockResolvedValue(
        createMockJobStatus({ state: 'completed', exitCode: 0 }),
      );
      const backend = new JobBackendImpl(ctx);

      const result: BackgroundWorkStatus = await backend.query('work-001');

      // Has exitOutcome (cera), not exitCode/signalName (dsh)
      expect(result).toHaveProperty('exitOutcome');
      expect(result).not.toHaveProperty('exitCode');
      expect(result).not.toHaveProperty('signalName');
    });

    it('BackgroundWork has cera types (command, args, cwd, env, timeout)', () => {
      const work: BackgroundWork = {
        command: 'cdo',
        args: ['-timmean'],
        cwd: '/scratch',
        env: { FOO: 'bar' },
        timeout: 5000,
      };

      expect(work.command).toBe('cdo');
      expect(work.args).toEqual(['-timmean']);
      expect(work.cwd).toBe('/scratch');
    });
  });
});
