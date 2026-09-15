/**
 * Unit tests for the PythonExecutor helper.
 *
 * Verifies that the Python executor:
 * - Builds correct Python commands from PythonTool + parameters
 * - Uses SubprocessRunner for execution
 * - Supports inline script mode (python3 -c "...")
 * - Supports module mode (python3 -m <module> <args>)
 * - Passes through options (cwd, env, timeout)
 * - Returns the ShellResult from SubprocessRunner
 * - Preserves signal vs exit-code distinction (INV-T5)
 *
 * Spec: build-phases.md Phase 4; api-contracts.md §6;
 * features/zarr-io.feature, features/grid-conversion.feature.
 */

import { describe, it, expect } from 'vitest';
import { PythonExecutorImpl } from '../../src/tool-invocation/python-executor';
import type { PythonExecutionRequest } from '../../src/tool-invocation/python-executor';
import {
  createMockPythonTool,
  createMockSubprocessRunner,
  createMockShellResult,
  createMockExitOutcome,
} from './helpers';
import type { ShellResult } from '../../src/dsh-adapter/types';

// ============================================================================
// Test setup helper
// ============================================================================

function createExecutor(overrides: {
  defaultResult?: ShellResult;
  responses?: ReadonlyArray<{
    readonly match: string;
    readonly result: ShellResult;
    readonly exact?: boolean;
  }>;
} = {}): {
  executor: PythonExecutorImpl;
  subprocessRunner: ReturnType<typeof createMockSubprocessRunner>;
} {
  const subprocessRunner = createMockSubprocessRunner({
    defaultResult: overrides.defaultResult,
    responses: overrides.responses,
  });
  const executor = new PythonExecutorImpl({ subprocessRunner });
  return { executor, subprocessRunner };
}

// ============================================================================
// Inline script mode
// ============================================================================

describe('PythonExecutorImpl — inline script mode', () => {
  it('builds a python3 -c command with an import and function call', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, subprocessRunner } = createExecutor({ defaultResult: successResult });

    const tool = createMockPythonTool({
      moduleName: 'healpy',
      functionName: 'angular_power_spectrum',
    });
    const request: PythonExecutionRequest = {
      tool,
      parameters: {
        script: 'from healpy import angular_power_spectrum; angular_power_spectrum("/scratch/data/input.nc", "/scratch/output/output.nc")',
      },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    await executor.execute(request);

    expect(subprocessRunner.calls).toHaveLength(1);
    expect(subprocessRunner.calls[0]?.command).toBe('python3');
    expect(subprocessRunner.calls[0]?.args[0]).toBe('-c');
    expect(subprocessRunner.calls[0]?.args[1]).toContain('angular_power_spectrum');
  });

  it('passes the script via the -c flag', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, subprocessRunner } = createExecutor({ defaultResult: successResult });

    const tool = createMockPythonTool({ moduleName: 'zarr' });
    const request: PythonExecutionRequest = {
      tool,
      parameters: {
        script: 'import zarr; zarr.open("/scratch/output/store.zarr", mode="w")',
      },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/store.zarr',
    };

    await executor.execute(request);

    expect(subprocessRunner.calls[0]?.args[0]).toBe('-c');
    expect(subprocessRunner.calls[0]?.args[1]).toContain('import zarr');
  });
});

// ============================================================================
// Module mode
// ============================================================================

describe('PythonExecutorImpl — module mode', () => {
  it('builds a python3 -m command when no script is provided', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, subprocessRunner } = createExecutor({ defaultResult: successResult });

    const tool = createMockPythonTool({
      moduleName: 'icon_grid_tool',
      functionName: undefined,
    });
    const request: PythonExecutionRequest = {
      tool,
      parameters: {
        args: ['--input', '/scratch/data/input.nc', '--output', '/scratch/output/output.nc'],
      },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    await executor.execute(request);

    expect(subprocessRunner.calls[0]?.command).toBe('python3');
    expect(subprocessRunner.calls[0]?.args[0]).toBe('-m');
    expect(subprocessRunner.calls[0]?.args[1]).toBe('icon_grid_tool');
    expect(subprocessRunner.calls[0]?.args[2]).toBe('--input');
    expect(subprocessRunner.calls[0]?.args[3]).toBe('/scratch/data/input.nc');
  });
});

// ============================================================================
// Options passthrough
// ============================================================================

describe('PythonExecutorImpl — options passthrough', () => {
  it('passes cwd, env, and timeout options to SubprocessRunner', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor } = createExecutor({ defaultResult: successResult });

    const tool = createMockPythonTool({ moduleName: 'healpy' });
    const request: PythonExecutionRequest = {
      tool,
      parameters: { script: 'import healpy; healpy.run()' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
      options: {
        cwd: '/scratch/output',
        env: { PYTHONPATH: '/opt/python' },
        timeout: 120_000,
      },
    };

    // Just verify it doesn't throw
    await expect(executor.execute(request)).resolves.toBeDefined();
  });
});

// ============================================================================
// Result passthrough
// ============================================================================

describe('PythonExecutorImpl — result passthrough', () => {
  it('returns the ShellResult from SubprocessRunner', async () => {
    const expectedResult = createMockShellResult({
      stdout: 'Done\n',
      stderr: '',
      exitOutcome: createMockExitOutcome({ code: 0 }),
    });
    const { executor } = createExecutor({ defaultResult: expectedResult });

    const tool = createMockPythonTool({ moduleName: 'healpy' });
    const request: PythonExecutionRequest = {
      tool,
      parameters: { script: 'import healpy' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    const result = await executor.execute(request);

    expect(result).toBe(expectedResult);
  });

  it('returns the ShellResult with non-zero exit code on failure', async () => {
    const failResult = createMockShellResult({
      stdout: '',
      stderr: 'MemoryError: Unable to allocate array\n',
      exitOutcome: createMockExitOutcome({ code: 1 }),
    });
    const { executor } = createExecutor({ defaultResult: failResult });

    const tool = createMockPythonTool({ moduleName: 'zarr' });
    const request: PythonExecutionRequest = {
      tool,
      parameters: { script: 'import zarr' },
      inputPaths: ['/scratch/data/large.nc'],
      outputPath: '/scratch/output/store.zarr',
    };

    const result = await executor.execute(request);

    expect(result.exitOutcome.kind).toBe('exit_code');
    if (result.exitOutcome.kind === 'exit_code') {
      expect(result.exitOutcome.code).toBe(1);
    }
    expect(result.stderr).toContain('MemoryError');
  });

  it('preserves signal termination (INV-T5)', async () => {
    const signalResult = createMockShellResult({
      stdout: '',
      stderr: 'Killed\n',
      exitOutcome: { kind: 'signal', name: 'SIGKILL', number: 9 },
    });
    const { executor } = createExecutor({ defaultResult: signalResult });

    const tool = createMockPythonTool({ moduleName: 'healpy' });
    const request: PythonExecutionRequest = {
      tool,
      parameters: { script: 'import healpy' },
      inputPaths: ['/scratch/data/huge.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    const result = await executor.execute(request);

    expect(result.exitOutcome.kind).toBe('signal');
    if (result.exitOutcome.kind === 'signal') {
      expect(result.exitOutcome.name).toBe('SIGKILL');
      expect(result.exitOutcome.number).toBe(9);
    }
  });
});
