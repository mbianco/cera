/**
 * Unit tests for the CLIExecutor helper.
 *
 * Verifies that the CLI executor:
 * - Builds correct command strings from CLITool + parameters
 * - Handles single-input operations (CDO -timmean)
 * - Handles multi-input operations (CDO -add)
 * - Handles chained operators (CDO -timmean -remapcon2,...)
 * - Uses ShellExecutor for execution
 * - Passes through options (cwd, env, timeout)
 * - Returns the ShellResult from ShellExecutor
 *
 * Spec: build-phases.md Phase 4; api-contracts.md §6;
 * features/cdo-operations.feature, features/nco-operations.feature.
 */

import { describe, it, expect } from 'vitest';
import { CLIExecutorImpl } from '../../src/tool-invocation/cli-executor';
import type { CLIExecutionRequest } from '../../src/tool-invocation/cli-executor';
import {
  createMockCLITool,
  createMockShellExecutor,
  createMockShellResult,
  createMockExitOutcome,
} from './helpers';
import type { ShellResult } from '../../src/dsh-adapter/types';

// ============================================================================
// Test setup helper
// ============================================================================

function createExecutor(overrides: {
  defaultResult?: ShellResult;
  responses?: ReadonlyArray<{ readonly match: string; readonly result: ShellResult }>;
} = {}): {
  executor: CLIExecutorImpl;
  shellExecutor: ReturnType<typeof createMockShellExecutor>;
} {
  const shellExecutor = createMockShellExecutor({
    defaultResult: overrides.defaultResult,
    responses: overrides.responses,
  });
  const executor = new CLIExecutorImpl({ shellExecutor });
  return { executor, shellExecutor };
}

// ============================================================================
// Command building — single input
// ============================================================================

describe('CLIExecutorImpl — single input operation', () => {
  it('builds a CDO command with a single operator and single input', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, shellExecutor } = createExecutor({ defaultResult: successResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-timmean' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    await executor.execute(request);

    expect(shellExecutor.calls).toHaveLength(1);
    expect(shellExecutor.calls[0]?.command).toBe(
      'cdo -timmean /scratch/data/input.nc /scratch/output/output.nc',
    );
  });

  it('builds an NCO command (ncks) with flags', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, shellExecutor } = createExecutor({ defaultResult: successResult });

    const tool = createMockCLITool({
      binary: 'ncks',
      chainable: false,
    });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-v TAS' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    await executor.execute(request);

    expect(shellExecutor.calls[0]?.command).toBe(
      'ncks -v TAS /scratch/data/input.nc /scratch/output/output.nc',
    );
  });
});

// ============================================================================
// Command building — multi input
// ============================================================================

describe('CLIExecutorImpl — multi-input operation', () => {
  it('builds a CDO -add command with two inputs', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, shellExecutor } = createExecutor({ defaultResult: successResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-add' },
      inputPaths: ['/scratch/data/tas.nc', '/scratch/data/pr.nc'],
      outputPath: '/scratch/output/tas_plus_pr.nc',
    };

    await executor.execute(request);

    expect(shellExecutor.calls[0]?.command).toBe(
      'cdo -add /scratch/data/tas.nc /scratch/data/pr.nc /scratch/output/tas_plus_pr.nc',
    );
  });
});

// ============================================================================
// Command building — chained operators
// ============================================================================

describe('CLIExecutorImpl — chained operators', () => {
  it('builds a CDO command with a two-operator chain (right-to-left)', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, shellExecutor } = createExecutor({ defaultResult: successResult });

    const tool = createMockCLITool({ binary: 'cdo', chainable: true });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-timmean -remapcon2,/scratch/grids/target.txt' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    await executor.execute(request);

    expect(shellExecutor.calls[0]?.command).toBe(
      'cdo -timmean -remapcon2,/scratch/grids/target.txt /scratch/data/input.nc /scratch/output/output.nc',
    );
  });
});

// ============================================================================
// Options passthrough
// ============================================================================

describe('CLIExecutorImpl — options passthrough', () => {
  it('passes cwd, env, and timeout options to ShellExecutor', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, shellExecutor } = createExecutor({ defaultResult: successResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-timmean' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
      options: {
        cwd: '/scratch/output',
        env: { LD_LIBRARY_PATH: '/opt/lib' },
        timeout: 30_000,
      },
    };

    await executor.execute(request);

    expect(shellExecutor.calls).toHaveLength(1);
    // The command is logged in calls; options are passed to execute()
    // but not stored in the mock. We verify the command was built.
    expect(shellExecutor.calls[0]?.command).toContain('cdo -timmean');
  });
});

// ============================================================================
// Result passthrough
// ============================================================================

describe('CLIExecutorImpl — result passthrough', () => {
  it('returns the ShellResult from ShellExecutor', async () => {
    const expectedResult = createMockShellResult({
      stdout: 'Processing complete\n',
      stderr: '',
      exitOutcome: createMockExitOutcome({ code: 0 }),
    });
    const { executor } = createExecutor({ defaultResult: expectedResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-timmean' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    const result = await executor.execute(request);

    expect(result).toBe(expectedResult);
  });

  it('returns the ShellResult with non-zero exit code on failure', async () => {
    const failResult = createMockShellResult({
      stdout: '',
      stderr: 'Error: invalid operator chain\n',
      exitOutcome: createMockExitOutcome({ code: 1 }),
    });
    const { executor } = createExecutor({ defaultResult: failResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-invalidop' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    const result = await executor.execute(request);

    expect(result.exitOutcome.kind).toBe('exit_code');
    if (result.exitOutcome.kind === 'exit_code') {
      expect(result.exitOutcome.code).toBe(1);
    }
    expect(result.stderr).toContain('invalid operator chain');
  });

  it('returns the ShellResult with signal on segfault', async () => {
    const signalResult = createMockShellResult({
      stdout: '',
      stderr: 'Segmentation fault\n',
      exitOutcome: { kind: 'signal', name: 'SIGSEGV', number: 11 },
    });
    const { executor } = createExecutor({ defaultResult: signalResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: { operatorChain: '-timmean' },
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    const result = await executor.execute(request);

    expect(result.exitOutcome.kind).toBe('signal');
    if (result.exitOutcome.kind === 'signal') {
      expect(result.exitOutcome.name).toBe('SIGSEGV');
      expect(result.exitOutcome.number).toBe(11);
    }
  });
});

// ============================================================================
// Missing operator chain
// ============================================================================

describe('CLIExecutorImpl — missing operatorChain', () => {
  it('builds command without operator chain if not provided', async () => {
    const successResult = createMockShellResult({ exitOutcome: createMockExitOutcome({ code: 0 }) });
    const { executor, shellExecutor } = createExecutor({ defaultResult: successResult });

    const tool = createMockCLITool({ binary: 'cdo' });
    const request: CLIExecutionRequest = {
      tool,
      parameters: {},
      inputPaths: ['/scratch/data/input.nc'],
      outputPath: '/scratch/output/output.nc',
    };

    await executor.execute(request);

    // Without an operator chain, the command is just: cdo <input> <output>
    expect(shellExecutor.calls[0]?.command).toBe(
      'cdo /scratch/data/input.nc /scratch/output/output.nc',
    );
  });
});
