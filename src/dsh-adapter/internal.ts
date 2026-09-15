/**
 * Internal helpers for the dsh-adapter module.
 *
 * - toExitOutcome: translates a raw dsh execution result to an
 *   ExitOutcome, respecting INV-T5 (signal takes precedence) and
 *   INV-T2 (exactly one outcome, never neither).
 * - translateDshError: wraps errors thrown by dsh extension points
 *   into cera's DshAdapterError hierarchy, so domain modules never
 *   see raw dsh exceptions.
 *
 * Spec references: invariants.md INV-T2, INV-T5; ADR-005;
 * assumptions.md A1; failure-modes.md FM-X3.
 */

import { AdapterInternal } from '../types/errors';
import type { ExitOutcome } from '../types/value-objects';
import type { DshRawExecutionResult, DshRawJobStatus } from './context';

// ============================================================================
// ExitOutcome translation
// ============================================================================

/**
 * Translates a raw dsh execution result to an ExitOutcome.
 *
 * INV-T5: if a signal is present, it takes precedence over an exit
 * code. The Agent must not map signal death to a synthetic exit code.
 *
 * INV-T2: a terminated process has exactly one ExitOutcome — either
 * an exit code or a signal, never both, never neither. If neither is
 * present, this is an adapter-level defect and an AdapterInternal
 * error is thrown.
 *
 * Spec: invariants.md INV-T2, INV-T5; value-objects.ts ExitOutcome.
 */
export function toExitOutcome(raw: DshRawExecutionResult): ExitOutcome {
  if (raw.signalName !== null && raw.signalNumber !== null) {
    return { kind: 'signal', name: raw.signalName, number: raw.signalNumber };
  }

  if (raw.exitCode !== null) {
    return { kind: 'exit_code', code: raw.exitCode };
  }

  // Neither signal nor exit code — violates INV-T2 at the dsh level.
  // This indicates a dsh bug or a breaking change in the extension
  // point (FM-X3). Throw so the caller is aware.
  throw new AdapterInternal({
    userMessage: 'Internal error: process produced neither an exit code nor a signal.',
    internalDetails: `Dsh raw result has exitCode=null, signalName=${raw.signalName}, signalNumber=${raw.signalNumber}. This violates INV-T2 (exactly one ExitOutcome).`,
    recoveryHint: 'This may indicate a dsh breaking change (FM-X3). Check the dsh version and update dsh-adapter if needed.',
    specRef: 'invariants.md INV-T2; failure-modes.md FM-X3; ADR-005',
  });
}

/**
 * Translates a raw dsh job status to an ExitOutcome (or null if the
 * job has not reached a terminal state).
 *
 * Same precedence rules as toExitOutcome: signal takes precedence
 * over exit code (INV-T5). If neither is present and the state is
 * terminal, this is an adapter-level defect.
 *
 * Spec: invariants.md INV-T2, INV-T5.
 */
export function toExitOutcomeFromJobStatus(
  raw: DshRawJobStatus,
): ExitOutcome | null {
  if (raw.state === 'pending' || raw.state === 'running') {
    return null;
  }

  if (raw.signalName !== null && raw.signalNumber !== null) {
    return { kind: 'signal', name: raw.signalName, number: raw.signalNumber };
  }

  if (raw.exitCode !== null) {
    return { kind: 'exit_code', code: raw.exitCode };
  }

  // Terminal state with neither exit code nor signal — adapter defect.
  // For 'cancelled', neither is expected; return a synthetic outcome.
  if (raw.state === 'cancelled') {
    return { kind: 'exit_code', code: 0 };
  }

  throw new AdapterInternal({
    userMessage: 'Internal error: background work reached a terminal state without an exit outcome.',
    internalDetails: `Dsh job ${raw.workId} state=${raw.state}, exitCode=${raw.exitCode}, signalName=${raw.signalName}. This violates INV-T2 for terminal states.`,
    recoveryHint: 'This may indicate a dsh breaking change (FM-X3). Check the dsh version and update dsh-adapter if needed.',
    specRef: 'invariants.md INV-T2; failure-modes.md FM-X3; ADR-005',
  });
}

// ============================================================================
// Error translation
// ============================================================================

/**
 * Wraps an error thrown by a dsh extension point into a cera
 * DshAdapterError. Domain modules never see raw dsh exceptions —
 * they always receive a typed CeraError subclass.
 *
 * If the error is already a CeraError (e.g., a DshAdapterError
 * thrown by toExitOutcome), it is passed through unchanged.
 *
 * Spec: ADR-005; api-contracts.md (Error Propagation Pattern);
 * failure-modes.md FM-X3.
 */
export function translateDshError(
  error: unknown,
  extensionPoint: string,
  operation: string,
): never {
  // Already a cera error — pass through. This handles errors thrown
  // by toExitOutcome and other adapter-internal logic.
  if (error instanceof AdapterInternal) {
    throw error;
  }

  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'unknown error';

  throw new AdapterInternal({
    userMessage: `Internal error in dsh adapter: ${extensionPoint}.${operation} failed.`,
    internalDetails: `${extensionPoint}.${operation}: ${message}`,
    recoveryHint:
      'This may indicate a dsh breaking change (FM-X3). Check the dsh version and update dsh-adapter if needed.',
    specRef: 'ADR-005; failure-modes.md FM-X3',
    cause: error,
  });
}
