/**
 * Unit tests for SubprocessRunner adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.subprocess.spawn and execute
 * - SubprocessHandle wraps the raw handle (pid, stdout, stderr)
 * - SubprocessHandle.wait() returns translated ShellResult
 * - SubprocessHandle.kill() delegates to raw handle
 * - Options pass-through
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * invariants.md INV-T2, INV-T5; ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import { SubprocessRunnerImpl } from '../../src/dsh-adapter/subprocess-runner';
import type {
  ShellResult,
  SubprocessRunner,
} from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockProcessHandle,
  createMockRawResult,
} from './helpers';

describe('SubprocessRunner', () => {
  describe('execute() delegation', () => {
    it('calls ctx.subprocess.execute with command, args, and no options by default', async () => {
      const ctx = createMockDshContext();
      const runner = new SubprocessRunnerImpl(ctx);

      await runner.execute('cdo', ['-timmean', 'in.nc', 'out.nc']);

      expect(ctx.subprocess.execute).toHaveBeenCalledWith(
        'cdo',
        ['-timmean', 'in.nc', 'out.nc'],
        undefined,
      );
    });

    it('calls ctx.subprocess.execute with provided options', async () => {
      const ctx = createMockDshContext();
      const runner = new SubprocessRunnerImpl(ctx);
      const options = {
        cwd: '/scratch/snx3000/cera_user',
        env: { LD_LIBRARY_PATH: '/opt/lib' },
        timeout: 60000,
        stdin: 'input data',
      };

      await runner.execute('ncks', ['-v', 'TAS'], options);

      expect(ctx.subprocess.execute).toHaveBeenCalledWith(
        'ncks',
        ['-v', 'TAS'],
        options,
      );
    });

    it('returns a ShellResult with translated ExitOutcome', async () => {
      const ctx = createMockDshContext();
      ctx.subprocess.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          stdout: 'result',
          stderr: '',
          exitCode: 0,
        }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      const result = await runner.execute('cdo', []);

      expect(result.stdout).toBe('result');
      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('translates signal termination (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.subprocess.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: 'SIGKILL',
          signalNumber: 9,
        }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      const result = await runner.execute('long-running', []);

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGKILL',
        number: 9,
      });
    });
  });

  describe('execute() error translation', () => {
    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.subprocess.execute = vi.fn().mockRejectedValue(new Error('dsh error'));
      const runner = new SubprocessRunnerImpl(ctx);

      await expect(runner.execute('cdo', [])).rejects.toThrow(AdapterInternal);
    });

    it('includes extension point and operation in error details', async () => {
      const ctx = createMockDshContext();
      ctx.subprocess.execute = vi.fn().mockRejectedValue(new Error('dsh error'));
      const runner = new SubprocessRunnerImpl(ctx);

      try {
        await runner.execute('cdo', []);
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterInternal);
        const adapterError = error as AdapterInternal;
        expect(adapterError.internalDetails).toContain('ctx.subprocess');
        expect(adapterError.internalDetails).toContain('execute');
      }
    });

    it('throws AdapterInternal when neither exit code nor signal (INV-T2)', async () => {
      const ctx = createMockDshContext();
      ctx.subprocess.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: null,
          signalNumber: null,
        }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      await expect(runner.execute('broken', [])).rejects.toThrow(AdapterInternal);
    });
  });

  describe('spawn() delegation', () => {
    it('calls ctx.subprocess.spawn with command, args, and no options by default', () => {
      const ctx = createMockDshContext();
      const runner = new SubprocessRunnerImpl(ctx);

      runner.spawn('cdo', ['-timmean', 'in.nc', 'out.nc']);

      expect(ctx.subprocess.spawn).toHaveBeenCalledWith(
        'cdo',
        ['-timmean', 'in.nc', 'out.nc'],
        undefined,
      );
    });

    it('calls ctx.subprocess.spawn with provided options', () => {
      const ctx = createMockDshContext();
      const runner = new SubprocessRunnerImpl(ctx);
      const options = {
        cwd: '/scratch',
        env: { FOO: 'bar' },
        timeout: 30000,
      };

      runner.spawn('ncks', ['-v', 'TAS'], options);

      expect(ctx.subprocess.spawn).toHaveBeenCalledWith(
        'ncks',
        ['-v', 'TAS'],
        options,
      );
    });

    it('returns a SubprocessHandle with the correct pid', () => {
      const ctx = createMockDshContext();
      ctx.subprocess.spawn = vi.fn().mockReturnValue(
        createMockProcessHandle({ pid: 99999 }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      expect(handle.pid).toBe(99999);
    });

    it('wraps dsh spawn errors in AdapterInternal', () => {
      const ctx = createMockDshContext();
      ctx.subprocess.spawn = vi.fn().mockImplementation(() => {
        throw new Error('dsh spawn error');
      });
      const runner = new SubprocessRunnerImpl(ctx);

      expect(() => runner.spawn('cdo', [])).toThrow(AdapterInternal);
    });
  });

  describe('SubprocessHandle', () => {
    it('exposes stdout stream from the raw handle', () => {
      const mockStream = (async function* () {
        yield 'line1';
        yield 'line2';
      })();
      const ctx = createMockDshContext();
      ctx.subprocess.spawn = vi.fn().mockReturnValue(
        createMockProcessHandle({ stdout: mockStream }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      expect(handle.stdout).toBe(mockStream);
    });

    it('exposes stderr stream from the raw handle', () => {
      const mockStream = (async function* () {
        yield 'error1';
      })();
      const ctx = createMockDshContext();
      ctx.subprocess.spawn = vi.fn().mockReturnValue(
        createMockProcessHandle({ stderr: mockStream }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      expect(handle.stderr).toBe(mockStream);
    });

    it('wait() returns a ShellResult with translated ExitOutcome', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        wait: vi.fn().mockResolvedValue(
          createMockRawResult({
            stdout: 'done',
            stderr: '',
            exitCode: 0,
          }),
        ),
      });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);
      const result = await handle.wait();

      expect(result.stdout).toBe('done');
      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('wait() translates signal termination (INV-T5)', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        wait: vi.fn().mockResolvedValue(
          createMockRawResult({
            exitCode: 137,
            signalName: 'SIGKILL',
            signalNumber: 9,
          }),
        ),
      });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('long-running', []);
      const result = await handle.wait();

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGKILL',
        number: 9,
      });
    });

    it('wait() throws AdapterInternal when dsh wait fails', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        wait: vi.fn().mockRejectedValue(new Error('dsh wait error')),
      });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      await expect(handle.wait()).rejects.toThrow(AdapterInternal);
    });

    it('wait() throws AdapterInternal when neither exit code nor signal (INV-T2)', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        wait: vi.fn().mockResolvedValue(
          createMockRawResult({
            exitCode: null,
            signalName: null,
            signalNumber: null,
          }),
        ),
      });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('broken', []);

      await expect(handle.wait()).rejects.toThrow(AdapterInternal);
    });

    it('kill() delegates to the raw handle', async () => {
      const ctx = createMockDshContext();
      const rawKill = vi.fn().mockResolvedValue(undefined);
      const rawHandle = createMockProcessHandle({ kill: rawKill });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);
      await handle.kill('SIGTERM');

      expect(rawKill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kill() works without a signal argument', async () => {
      const ctx = createMockDshContext();
      const rawKill = vi.fn().mockResolvedValue(undefined);
      const rawHandle = createMockProcessHandle({ kill: rawKill });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);
      await handle.kill();

      expect(rawKill).toHaveBeenCalledWith(undefined);
    });

    it('kill() wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        kill: vi.fn().mockRejectedValue(new Error('dsh kill error')),
      });
      ctx.subprocess.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      await expect(handle.kill()).rejects.toThrow(AdapterInternal);
    });
  });

  describe('interface stability', () => {
    it('implements the SubprocessRunner interface', () => {
      const ctx = createMockDshContext();
      const runner: SubprocessRunner = new SubprocessRunnerImpl(ctx);

      expect(typeof runner.spawn).toBe('function');
      expect(typeof runner.execute).toBe('function');
    });

    it('SubprocessHandle has exactly pid, stdout, stderr, kill, wait', () => {
      const ctx = createMockDshContext();
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      expect(typeof handle.pid).toBe('number');
      expect(typeof handle.kill).toBe('function');
      expect(typeof handle.wait).toBe('function');
      // stdout and stderr are AsyncIterable
      expect(typeof (handle.stdout as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
      expect(typeof (handle.stderr as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function');
    });

    it('does not expose the raw dsh handle', () => {
      const ctx = createMockDshContext();
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);

      // The wrapper should not expose the raw handle
      expect(handle).not.toHaveProperty('raw');
    });

    it('wait() returns ShellResult, not raw dsh type', async () => {
      const ctx = createMockDshContext();
      ctx.subprocess.spawn = vi.fn().mockReturnValue(
        createMockProcessHandle({
          wait: vi.fn().mockResolvedValue(createMockRawResult({ exitCode: 0 })),
        }),
      );
      const runner = new SubprocessRunnerImpl(ctx);

      const handle = runner.spawn('cdo', []);
      const result: ShellResult = await handle.wait();

      // ShellResult should have exitOutcome (cera type), not exitCode/signalName (dsh type)
      expect(result).toHaveProperty('exitOutcome');
      expect(result).not.toHaveProperty('exitCode');
      expect(result).not.toHaveProperty('signalName');
    });
  });
});
