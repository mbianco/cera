/**
 * Unit tests for internal helper functions.
 *
 * Verifies:
 * - toExitOutcome: exit code, signal, precedence (INV-T5), INV-T2
 * - toExitOutcomeFromJobStatus: null for non-terminal, translation
 *   for terminal, INV-T2 for terminal without outcome
 * - translateDshError: wraps errors in AdapterInternal, passes
 *   through existing AdapterInternal
 *
 * Spec: invariants.md INV-T2, INV-T5; ADR-005;
 * failure-modes.md FM-X3; api-contracts.md (Error Propagation).
 */

import { describe, it, expect } from 'vitest';
import { AdapterInternal } from '../../src/types/errors';
import type { ExitOutcome } from '../../src/types/value-objects';
import {
  toExitOutcome,
  toExitOutcomeFromJobStatus,
  translateDshError,
} from '../../src/dsh-adapter/internal';
import type {
  DshRawExecutionResult,
  DshRawJobStatus,
} from '../../src/dsh-adapter/context';

// ============================================================================
// Helpers for creating raw types in tests
// ============================================================================

function rawResult(overrides: Partial<DshRawExecutionResult> = {}): DshRawExecutionResult {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    signalName: null,
    signalNumber: null,
    ...overrides,
  };
}

function jobStatus(overrides: Partial<DshRawJobStatus> = {}): DshRawJobStatus {
  return {
    workId: 'work-001',
    state: 'pending',
    exitCode: null,
    signalName: null,
    signalNumber: null,
    ...overrides,
  };
}

// ============================================================================
// toExitOutcome
// ============================================================================

describe('toExitOutcome', () => {
  it('translates exit code 0', () => {
    const outcome = toExitOutcome(rawResult({ exitCode: 0 }));
    expect(outcome).toEqual<ExitOutcome>({ kind: 'exit_code', code: 0 });
  });

  it('translates non-zero exit code', () => {
    const outcome = toExitOutcome(rawResult({ exitCode: 1 }));
    expect(outcome).toEqual<ExitOutcome>({ kind: 'exit_code', code: 1 });
  });

  it('translates signal termination', () => {
    const outcome = toExitOutcome(
      rawResult({ exitCode: null, signalName: 'SIGSEGV', signalNumber: 11 }),
    );
    expect(outcome).toEqual<ExitOutcome>({
      kind: 'signal',
      name: 'SIGSEGV',
      number: 11,
    });
  });

  it('signal takes precedence over exit code (INV-T5)', () => {
    const outcome = toExitOutcome(
      rawResult({ exitCode: 139, signalName: 'SIGSEGV', signalNumber: 11 }),
    );
    expect(outcome).toEqual<ExitOutcome>({
      kind: 'signal',
      name: 'SIGSEGV',
      number: 11,
    });
  });

  it('throws AdapterInternal when neither exit code nor signal (INV-T2)', () => {
    expect(() =>
      toExitOutcome(
        rawResult({ exitCode: null, signalName: null, signalNumber: null }),
      ),
    ).toThrow(AdapterInternal);
  });

  it('throws AdapterInternal when signal name present but number null', () => {
    expect(() =>
      toExitOutcome(
        rawResult({ exitCode: null, signalName: 'SIGTERM', signalNumber: null }),
      ),
    ).toThrow(AdapterInternal);
  });

  it('throws AdapterInternal when signal number present but name null', () => {
    expect(() =>
      toExitOutcome(
        rawResult({ exitCode: null, signalName: null, signalNumber: 15 }),
      ),
    ).toThrow(AdapterInternal);
  });

  it('AdapterInternal from INV-T2 violation mentions INV-T2', () => {
    try {
      toExitOutcome(
        rawResult({ exitCode: null, signalName: null, signalNumber: null }),
      );
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterInternal);
      const adapterError = error as AdapterInternal;
      expect(adapterError.internalDetails).toContain('INV-T2');
    }
  });
});

// ============================================================================
// toExitOutcomeFromJobStatus
// ============================================================================

describe('toExitOutcomeFromJobStatus', () => {
  it('returns null for pending state', () => {
    const outcome = toExitOutcomeFromJobStatus(jobStatus({ state: 'pending' }));
    expect(outcome).toBeNull();
  });

  it('returns null for running state', () => {
    const outcome = toExitOutcomeFromJobStatus(jobStatus({ state: 'running' }));
    expect(outcome).toBeNull();
  });

  it('translates exit code for completed state', () => {
    const outcome = toExitOutcomeFromJobStatus(
      jobStatus({ state: 'completed', exitCode: 0 }),
    );
    expect(outcome).toEqual<ExitOutcome>({ kind: 'exit_code', code: 0 });
  });

  it('translates non-zero exit code for failed state', () => {
    const outcome = toExitOutcomeFromJobStatus(
      jobStatus({ state: 'failed', exitCode: 1 }),
    );
    expect(outcome).toEqual<ExitOutcome>({ kind: 'exit_code', code: 1 });
  });

  it('translates signal for failed state (INV-T5)', () => {
    const outcome = toExitOutcomeFromJobStatus(
      jobStatus({ state: 'failed', exitCode: null, signalName: 'SIGKILL', signalNumber: 9 }),
    );
    expect(outcome).toEqual<ExitOutcome>({
      kind: 'signal',
      name: 'SIGKILL',
      number: 9,
    });
  });

  it('signal takes precedence over exit code for job status (INV-T5)', () => {
    const outcome = toExitOutcomeFromJobStatus(
      jobStatus({ state: 'failed', exitCode: 137, signalName: 'SIGKILL', signalNumber: 9 }),
    );
    expect(outcome).toEqual<ExitOutcome>({
      kind: 'signal',
      name: 'SIGKILL',
      number: 9,
    });
  });

  it('returns exit_code: 0 for cancelled state (no exit info)', () => {
    const outcome = toExitOutcomeFromJobStatus(
      jobStatus({ state: 'cancelled', exitCode: null, signalName: null }),
    );
    expect(outcome).toEqual<ExitOutcome>({ kind: 'exit_code', code: 0 });
  });

  it('throws AdapterInternal for completed state without outcome (INV-T2)', () => {
    expect(() =>
      toExitOutcomeFromJobStatus(
        jobStatus({ state: 'completed', exitCode: null, signalName: null }),
      ),
    ).toThrow(AdapterInternal);
  });

  it('throws AdapterInternal for failed state without outcome (INV-T2)', () => {
    expect(() =>
      toExitOutcomeFromJobStatus(
        jobStatus({ state: 'failed', exitCode: null, signalName: null }),
      ),
    ).toThrow(AdapterInternal);
  });
});

// ============================================================================
// translateDshError
// ============================================================================

describe('translateDshError', () => {
  it('wraps Error in AdapterInternal', () => {
    expect(() =>
      translateDshError(new Error('dsh error'), 'ctx.shell', 'execute'),
    ).toThrow(AdapterInternal);
  });

  it('wraps non-Error throws in AdapterInternal', () => {
    expect(() =>
      translateDshError('string error', 'ctx.fs', 'stat'),
    ).toThrow(AdapterInternal);
  });

  it('wraps unknown values in AdapterInternal', () => {
    expect(() =>
      translateDshError(42, 'ctx.jobs', 'submit'),
    ).toThrow(AdapterInternal);
  });

  it('includes extension point and operation in error details', () => {
    try {
      translateDshError(new Error('dsh error'), 'ctx.shell', 'execute');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterInternal);
      const adapterError = error as AdapterInternal;
      expect(adapterError.internalDetails).toContain('ctx.shell');
      expect(adapterError.internalDetails).toContain('execute');
      expect(adapterError.internalDetails).toContain('dsh error');
    }
  });

  it('passes through existing AdapterInternal unchanged', () => {
    const original = new AdapterInternal({
      userMessage: 'Original error',
      internalDetails: 'Original details',
      recoveryHint: 'Original hint',
      specRef: 'Original spec ref',
    });

    try {
      translateDshError(original, 'ctx.shell', 'execute');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBe(original);
    }
  });

  it('includes the original error as cause', () => {
    const original = new Error('root cause');

    try {
      translateDshError(original, 'ctx.shell', 'execute');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterInternal);
      const adapterError = error as AdapterInternal;
      expect(adapterError.cause).toBe(original);
    }
  });

  it('handles null error', () => {
    expect(() =>
      translateDshError(null, 'ctx.fs', 'exists'),
    ).toThrow(AdapterInternal);
  });

  it('handles undefined error', () => {
    expect(() =>
      translateDshError(undefined, 'ctx.fs', 'exists'),
    ).toThrow(AdapterInternal);
  });
});
