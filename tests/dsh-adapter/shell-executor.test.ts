/**
 * Unit tests for ShellExecutor adapter.
 *
 * Verifies:
 * - Correct delegation to ctx.shell.execute
 * - ExitOutcome translation (exit code, signal, INV-T2, INV-T5)
 * - Options pass-through (cwd, env, timeout, stdin)
 * - Error translation (dsh errors → AdapterInternal)
 * - No dsh types leak in public signatures
 *
 * Spec: build-phases.md Phase 1; api-contracts.md §1;
 * invariants.md INV-T2, INV-T5; ADR-005.
 */

import { describe, it, expect, vi } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import type { ExitOutcome } from '../../src/types/value-objects';
import { ShellExecutorImpl } from '../../src/dsh-adapter/shell-executor';
import type { ShellExecutor, ShellResult } from '../../src/dsh-adapter/types';
import {
  createMockDshContext,
  createMockRawResult,
} from './helpers';

describe('ShellExecutor', () => {
  describe('delegation', () => {
    it('calls ctx.shell.execute with the command and no options by default', async () => {
      const ctx = createMockDshContext();
      const executor = new ShellExecutorImpl(ctx);

      await executor.execute('echo hello');

      expect(ctx.shell.execute).toHaveBeenCalledWith('echo hello', undefined);
    });

    it('calls ctx.shell.execute with provided options', async () => {
      const ctx = createMockDshContext();
      const executor = new ShellExecutorImpl(ctx);
      const options = {
        cwd: '/tmp',
        env: { FOO: 'bar' },
        timeout: 5000,
        stdin: 'input data',
      };

      await executor.execute('cdo -timmean', options);

      expect(ctx.shell.execute).toHaveBeenCalledWith('cdo -timmean', options);
    });

    it('returns a ShellResult with stdout, stderr, and exitOutcome', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          stdout: 'hello world',
          stderr: '',
          exitCode: 0,
        }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('echo hello world');

      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.exitOutcome).toEqual({
        kind: 'exit_code',
        code: 0,
      });
    });

    it('passes through stdout and stderr exactly', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          stdout: 'line1\nline2\n',
          stderr: 'warning: something\n',
          exitCode: 0,
        }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('cdo info');

      expect(result.stdout).toBe('line1\nline2\n');
      expect(result.stderr).toBe('warning: something\n');
    });
  });

  describe('ExitOutcome translation (INV-T2, INV-T5)', () => {
    it('translates exit code 0 to { kind: "exit_code", code: 0 }', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({ exitCode: 0, signalName: null, signalNumber: null }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('true');

      expect(result.exitOutcome).toEqual<ExitOutcome>({
        kind: 'exit_code',
        code: 0,
      });
    });

    it('translates non-zero exit code to { kind: "exit_code", code: N }', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({ exitCode: 1, signalName: null, signalNumber: null }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('false');

      expect(result.exitOutcome).toEqual<ExitOutcome>({
        kind: 'exit_code',
        code: 1,
      });
    });

    it('translates signal termination to { kind: "signal", name, number } (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: 'SIGSEGV',
          signalNumber: 11,
        }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('segfaulting-binary');

      expect(result.exitOutcome).toEqual<ExitOutcome>({
        kind: 'signal',
        name: 'SIGSEGV',
        number: 11,
      });
    });

    it('signal takes precedence over exit code (INV-T5)', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: 139,
          signalName: 'SIGSEGV',
          signalNumber: 11,
        }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('segfaulting-binary');

      expect(result.exitOutcome).toEqual<ExitOutcome>({
        kind: 'signal',
        name: 'SIGSEGV',
        number: 11,
      });
    });

    it('throws AdapterInternal when neither exit code nor signal is present (INV-T2)', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: null,
          signalNumber: null,
        }),
      );
      const executor = new ShellExecutorImpl(ctx);

      await expect(executor.execute('broken-tool')).rejects.toThrow(
        AdapterInternal,
      );
    });
  });

  describe('error translation', () => {
    it('wraps dsh errors in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockRejectedValue(new Error('dsh internal error'));
      const executor = new ShellExecutorImpl(ctx);

      await expect(executor.execute('echo hello')).rejects.toThrow(
        AdapterInternal,
      );
    });

    it('includes the extension point and operation in the error details', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockRejectedValue(new Error('dsh internal error'));
      const executor = new ShellExecutorImpl(ctx);

      try {
        await executor.execute('echo hello');
        expect.fail('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(AdapterInternal);
        const adapterError = error as AdapterInternal;
        expect(adapterError.internalDetails).toContain('ctx.shell');
        expect(adapterError.internalDetails).toContain('execute');
      }
    });

    it('wraps non-Error throws in AdapterInternal', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockRejectedValue('string error');
      const executor = new ShellExecutorImpl(ctx);

      await expect(executor.execute('echo hello')).rejects.toThrow(
        AdapterInternal,
      );
    });

    it('passes through AdapterInternal thrown by internal logic (e.g., toExitOutcome)', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({
          exitCode: null,
          signalName: null,
          signalNumber: null,
        }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const error = await executor.execute('broken').catch((e) => e);
      expect(error).toBeInstanceOf(AdapterInternal);
      expect((error as AdapterInternal).internalDetails).toContain('INV-T2');
    });
  });

  describe('interface stability', () => {
    it('exposes only execute() — no dsh methods or properties', () => {
      const ctx = createMockDshContext();
      const executor = new ShellExecutorImpl(ctx);

      expect(typeof executor.execute).toBe('function');
      // The public interface should not expose the ctx property
      expect(executor).not.toHaveProperty('ctx');
    });

    it('ShellResult has exactly stdout, stderr, exitOutcome', async () => {
      const ctx = createMockDshContext();
      const executor = new ShellExecutorImpl(ctx);

      const result = await executor.execute('echo hello');

      const keys = Object.keys(result).sort();
      expect(keys).toEqual(['exitOutcome', 'stderr', 'stdout']);
    });

    it('implements the ShellExecutor interface', () => {
      const ctx = createMockDshContext();
      const executor: ShellExecutor = new ShellExecutorImpl(ctx);

      expect(executor).toBeDefined();
      expect(typeof executor.execute).toBe('function');
    });

    it('ShellResult contains ExitOutcome, not raw dsh types', async () => {
      const ctx = createMockDshContext();
      ctx.shell.execute = vi.fn().mockResolvedValue(
        createMockRawResult({ exitCode: 0 }),
      );
      const executor = new ShellExecutorImpl(ctx);

      const result: ShellResult = await executor.execute('echo hello');

      // ExitOutcome is a discriminated union — check it has a kind
      expect(result.exitOutcome).toHaveProperty('kind');
      const kind = (result.exitOutcome as { kind: string }).kind;
      expect(['exit_code', 'signal']).toContain(kind);
    });
  });
});
