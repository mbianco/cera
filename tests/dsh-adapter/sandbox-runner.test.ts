/**
 * Unit tests for SandboxRunner adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.sandbox.execute and spawn
 * - SandboxOptions (allowedPaths, allowNetwork) pass-through
 * - SubprocessHandle wrapping (pid, stdout, stderr, wait, kill)
 * - ExitOutcome translation (INV-T2, INV-T5)
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * invariants.md INV-T2, INV-T5; ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import { SandboxRunnerImpl } from '../../src/dsh-adapter/sandbox-runner';
import type {
  SandboxOptions,
  SandboxRunner,
  ShellResult,
  SubprocessHandle,
} from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockProcessHandle,
  createMockRawResult,
} from './helpers';

describe('SandboxRunner', () => {
  describe('execute() delegation', () => {
    it('calls ctx.sandbox.execute with the command and no options by default', async () => {
      const ctx = createMockDshContext();
      const runner = new SandboxRunnerImpl(ctx);

      await runner.execute('legacy-binary');

      expect(ctx.sandbox.execute).toHaveBeenCalledWith('legacy-binary', undefined);
    });

    it('calls ctx.sandbox.execute with sandbox options (allowedPaths, allowNetwork)', async () => {
      const ctx = createMockDshContext();
      const runner = new SandboxRunnerImpl(ctx);
      const options: SandboxOptions = {
        cwd: '/sandbox',
        env: { FOO: 'bar' },
        timeout: 10000,
        allowedPaths: ['/scratch/input', '/scratch/output'],
        allowNetwork: false,
      };

      await runner.execute('legacy-binary', options);

      expect(ctx.sandbox.execute).toHaveBeenCalledWith('legacy-binary', options);
    });

    it('returns a ShellResult with translated ExitOutcome', async () => {
      const ctx = createMockDshContext();
      ctx.sandbox.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          stdout: 'output',
          stderr: '',
          exitCode: 0,
        }),
      );
      const runner = new SandboxRunnerImpl(ctx);

      const result = await runner.execute('legacy-binary');

      expect(result.stdout).toBe('output');
      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('translates signal termination (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.sandbox.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: 'SIGTERM',
          signalNumber: 15,
        }),
      );
      const runner = new SandboxRunnerImpl(ctx);

      const result = await runner.execute('legacy-binary');

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGTERM',
        number: 15,
      });
    });

    it('signal takes precedence over exit code (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.sandbox.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: 1,
          signalName: 'SIGSEGV',
          signalNumber: 11,
        }),
      );
      const runner = new SandboxRunnerImpl(ctx);

      const result = await runner.execute('legacy-binary');

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGSEGV',
        number: 11,
      });
    });

    it('throws AdapterInternal when neither exit code nor signal (INV-T2)', async () => {
      const ctx = createMockDshContext();
      ctx.sandbox.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: null,
          signalNumber: null,
        }),
      );
      const runner = new SandboxRunnerImpl(ctx);

      await expect(runner.execute('broken')).rejects.toThrow(AdapterInternal);
    });

    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.sandbox.execute = vi.fn().mockRejectedValue(new Error('sandbox error'));
      const runner = new SandboxRunnerImpl(ctx);

      await expect(runner.execute('legacy-binary')).rejects.toThrow(AdapterInternal);
    });
  });

  describe('spawn() delegation', () => {
    it('calls ctx.sandbox.spawn with command, args, and no options by default', () => {
      const ctx = createMockDshContext();
      const runner = new SandboxRunnerImpl(ctx);

      runner.spawn('legacy-binary', ['--flag', 'input.dat']);

      expect(ctx.sandbox.spawn).toHaveBeenCalledWith(
        'legacy-binary',
        ['--flag', 'input.dat'],
        undefined,
      );
    });

    it('calls ctx.sandbox.spawn with sandbox options', () => {
      const ctx = createMockDshContext();
      const runner = new SandboxRunnerImpl(ctx);
      const options: SandboxOptions = {
        cwd: '/sandbox',
        timeout: 5000,
        allowedPaths: ['/data'],
        allowNetwork: true,
      };

      runner.spawn('legacy-binary', ['--process'], options);

      expect(ctx.sandbox.spawn).toHaveBeenCalledWith(
        'legacy-binary',
        ['--process'],
        options,
      );
    });

    it('returns a SubprocessHandle with the correct pid', () => {
      const ctx = createMockDshContext();
      ctx.sandbox.spawn = vi.fn().mockReturnValue(
        createMockProcessHandle({ pid: 77777 }),
      );
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);

      expect(handle.pid).toBe(77777);
    });

    it('wraps dsh spawn errors in AdapterInternal', () => {
      const ctx = createMockDshContext();
      ctx.sandbox.spawn = vi.fn().mockImplementation(() => {
        throw new Error('dsh spawn error');
      });
      const runner = new SandboxRunnerImpl(ctx);

      expect(() => runner.spawn('legacy-binary', [])).toThrow(AdapterInternal);
    });
  });

  describe('SubprocessHandle (from sandbox)', () => {
    it('wait() returns a ShellResult with translated ExitOutcome', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        wait: vi.fn().mockResolvedValue(
          createMockRawResult({
            stdout: 'sandbox output',
            stderr: '',
            exitCode: 0,
          }),
        ),
      });
      ctx.sandbox.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);
      const result = await handle.wait();

      expect(result.stdout).toBe('sandbox output');
      expect(result.exitOutcome).toEqual({ kind: 'exit_code', code: 0 });
    });

    it('wait() translates signal termination (INV-T5)', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        wait: vi.fn().mockResolvedValue(
          createMockRawResult({
            exitCode: null,
            signalName: 'SIGKILL',
            signalNumber: 9,
          }),
        ),
      });
      ctx.sandbox.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);
      const result = await handle.wait();

      expect(result.exitOutcome).toEqual({
        kind: 'signal',
        name: 'SIGKILL',
        number: 9,
      });
    });

    it('kill() delegates to the raw handle', async () => {
      const ctx = createMockDshContext();
      const rawKill = vi.fn().mockResolvedValue(undefined);
      const rawHandle = createMockProcessHandle({ kill: rawKill });
      ctx.sandbox.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);
      await handle.kill('SIGTERM');

      expect(rawKill).toHaveBeenCalledWith('SIGTERM');
    });

    it('kill() wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      const rawHandle = createMockProcessHandle({
        kill: vi.fn().mockRejectedValue(new Error('dsh kill error')),
      });
      ctx.sandbox.spawn = vi.fn().mockReturnValue(rawHandle);
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);
      await expect(handle.kill()).rejects.toThrow(AdapterInternal);
    });
  });

  describe('interface stability', () => {
    it('implements the SandboxRunner interface', () => {
      const ctx = createMockDshContext();
      const runner: SandboxRunner = new SandboxRunnerImpl(ctx);

      expect(typeof runner.execute).toBe('function');
      expect(typeof runner.spawn).toBe('function');
    });

    it('does not expose the raw dsh handle', () => {
      const ctx = createMockDshContext();
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);

      expect(handle).not.toHaveProperty('raw');
    });

    it('SubprocessHandle from sandbox is the same interface as from subprocess', () => {
      const ctx = createMockDshContext();
      const runner = new SandboxRunnerImpl(ctx);

      const handle: SubprocessHandle = runner.spawn('legacy-binary', []);

      expect(typeof handle.pid).toBe('number');
      expect(typeof handle.kill).toBe('function');
      expect(typeof handle.wait).toBe('function');
    });

    it('wait() returns ShellResult, not raw dsh type', async () => {
      const ctx = createMockDshContext();
      ctx.sandbox.spawn = vi.fn().mockReturnValue(
        createMockProcessHandle({
          wait: vi.fn().mockResolvedValue(createMockRawResult({ exitCode: 0 })),
        }),
      );
      const runner = new SandboxRunnerImpl(ctx);

      const handle = runner.spawn('legacy-binary', []);
      const result: ShellResult = await handle.wait();

      expect(result).toHaveProperty('exitOutcome');
      expect(result).not.toHaveProperty('exitCode');
      expect(result).not.toHaveProperty('signalName');
    });
  });
});
