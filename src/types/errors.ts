/**
 * Error types for cera.
 *
 * These are STUBS — type definitions only, no implementation.
 * The error hierarchy is a discriminated union of CeraError
 * subclasses, as specified in error-taxonomy.md.
 *
 * Spec references: error-taxonomy.md, failure-modes.md, invariants.md,
 * resolutions.md (R4, R11, R12).
 */

import type {
  DatasetId,
  JobId,
  ToolId,
  ToolInvocationId,
  CaseId,
  Location,
  ResourceRequest,
  Conflict,
} from './value-objects';

// ============================================================================
// Base Error
// ============================================================================

/**
 * Base error for all cera errors. Every error carries:
 * - A discriminant `kind` for narrowing
 * - A severity from failure-modes.md
 * - A user-facing message (what the scientist sees)
 * - Internal details (for logging, not shown to the User)
 * - A recovery hint (suggested next action)
 *
 * Spec: error-taxonomy.md; api-contracts.md (Error Propagation Pattern).
 */
export abstract class CeraError extends Error {
  abstract readonly kind: string;
  abstract readonly severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  readonly userMessage: string;
  readonly internalDetails: string;
  readonly recoveryHint: string;
  readonly specRef: string;

  constructor(props: {
    userMessage: string;
    internalDetails: string;
    recoveryHint: string;
    specRef: string;
    cause?: unknown;
  }) {
    super(props.userMessage, { cause: props.cause });
    this.name = this.constructor.name;
    this.userMessage = props.userMessage;
    this.internalDetails = props.internalDetails;
    this.recoveryHint = props.recoveryHint;
    this.specRef = props.specRef;
  }
}

// ============================================================================
// DshAdapterError
// ============================================================================

export abstract class DshAdapterError extends CeraError {
  readonly kind: string = 'dsh_adapter';
}

/**
 * FM-X3: A dsh upgrade introduced a breaking change in a Cordis
 * extension point that cera's plugins depend on.
 *
 * Spec: failure-modes.md FM-X3; assumptions.md A1; ADR-005.
 */
export class FrameworkBreakingChange extends DshAdapterError {
  readonly kind = 'framework_breaking_change';
  readonly severity = 'CRITICAL' as const;

  constructor(props: {
    dshVersion: string;
    affectedExtensionPoint: string;
    cause?: unknown;
  }) {
    super({
      userMessage: '', // developer concern, not user-facing
      internalDetails: `dsh ${props.dshVersion} broke extension point: ${props.affectedExtensionPoint}`,
      recoveryHint: 'Pin to previous dsh version. Do not upgrade without running the full test suite (Tier 3).',
      specRef: 'failure-modes.md FM-X3; ADR-005',
      cause: props.cause,
    });
  }
}

/**
 * Internal error in the dsh-adapter isolation layer.
 */
export class AdapterInternal extends DshAdapterError {
  readonly kind = 'adapter_internal';
  readonly severity = 'HIGH' as const;
}

// ============================================================================
// ToolInvocationError (C1)
// ============================================================================

export abstract class ToolInvocationError extends CeraError {
  readonly kind: string = 'tool_invocation';
}

/**
 * INV-T1, FM-E1, FM-E3: The Tool's required Environment is not
 * loaded or has been purged.
 */
export class EnvironmentNotLoaded extends ToolInvocationError {
  readonly kind = 'environment_not_loaded';
  readonly severity = 'CRITICAL' as const;

  constructor(props: {
    toolId: ToolId;
    environmentId?: string;
    cause?: unknown;
  }) {
    super({
      userMessage: `The Environment required by Tool '${props.toolId}' is not loaded. The ToolInvocation has been rejected.`,
      internalDetails: `Tool ${props.toolId} requires environment ${props.environmentId ?? 'unknown'}, which is not active.`,
      recoveryHint: 'Load the required uenv before invoking the Tool.',
      specRef: 'invariants.md INV-T1; failure-modes.md FM-E1, FM-E3',
      cause: props.cause,
    });
  }
}

/**
 * FM-T5, FM-D3: An input Dataset's Location does not resolve.
 */
export class InputNotFound extends ToolInvocationError {
  readonly kind = 'input_not_found';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    datasetId: DatasetId;
    location: Location;
    cause: 'enoent' | 'eacces';
  }) {
    super({
      userMessage: `Input Dataset at '${props.location.path}' could not be found (${props.cause}). The ToolInvocation has been rejected.`,
      internalDetails: `Dataset ${props.datasetId} at ${props.location.path}: ${props.cause}`,
      recoveryHint: 'Verify the path or select a different input Dataset.',
      specRef: 'failure-modes.md FM-T5, FM-D3; invariants.md INV-D4',
    });
  }
}

/**
 * INV-D3, INV-W1, FM-P3: An input Dataset has no ProvenanceRecord.
 */
export class InputMissingProvenance extends ToolInvocationError {
  readonly kind = 'input_missing_provenance';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { datasetId: DatasetId; workflowStepId?: string }) {
    super({
      userMessage: `Dataset '${props.datasetId}' has no ProvenanceRecord and cannot be consumed. The WorkflowStep has been blocked.`,
      internalDetails: `Dataset ${props.datasetId} has no ProvenanceRecord${props.workflowStepId ? ` (WorkflowStep: ${props.workflowStepId})` : ''}.`,
      recoveryHint: 'Provide the missing Provenance manually or regenerate the Dataset.',
      specRef: 'invariants.md INV-D3, INV-W1; failure-modes.md FM-P3',
    });
  }
}

/**
 * FM-A2, FM-T4: Parameters do not match the Tool's schema or
 * input Dataset's metadata. R12: refuse and ask.
 */
export class InvalidParameters extends ToolInvocationError {
  readonly kind = 'invalid_parameters';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    toolId: ToolId;
    invalidParameters: string[];
    schema: unknown;
  }) {
    super({
      userMessage: `The parameters ${props.invalidParameters.join(', ')} for Tool '${props.toolId}' are invalid. Please check the parameter values.`,
      internalDetails: `Tool ${props.toolId}: invalid parameters ${props.invalidParameters.join(', ')}`,
      recoveryHint: 'Check the parameter values against the Tool schema and the input Dataset metadata.',
      specRef: 'failure-modes.md FM-A2, FM-T4; resolutions.md R12',
    });
  }
}

/**
 * FM-A1, R12: The LLM generated a Tool name that is not in the
 * catalog. The Agent refuses and asks the User.
 */
export class ToolNotFound extends ToolInvocationError {
  readonly kind = 'tool_not_found';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    requestedTool: string;
    availableTools: ToolId[];
  }) {
    super({
      userMessage: `The Tool '${props.requestedTool}' is not in the catalog. Available Tools: ${props.availableTools.join(', ')}. Please clarify which Tool you would like to use.`,
      internalDetails: `LLM requested '${props.requestedTool}', not in catalog.`,
      recoveryHint: 'Select a Tool from the available list.',
      specRef: 'failure-modes.md FM-A1; resolutions.md R12; ADR-010',
    });
  }
}

/**
 * FM-T3, R4: Non-zero exit code. Strict by default (any non-zero
 * blocks output registration) unless permissiveExitCodes is set.
 */
export class NonZeroExitCode extends ToolInvocationError {
  readonly kind = 'non_zero_exit_code';
  readonly severity = 'MEDIUM' as const;

  constructor(props: {
    exitCode: number;
    permissive: boolean;
    stderr: string;
    caseId?: CaseId;
    phase?: string;
  }) {
    const msg = props.permissive
      ? `Tool exited with code ${props.exitCode} (warning). Output has been registered with a warning flag.`
      : `Tool exited with code ${props.exitCode}. Output has NOT been registered (non-zero exit codes are failures by default).`;
    super({
      userMessage: msg,
      internalDetails: `Exit code ${props.exitCode}, permissive=${props.permissive}, stderr: ${props.stderr}`,
      recoveryHint: props.permissive
        ? 'The ProvenanceRecord records the non-zero exit code.'
        : 'If this exit code is a known non-error, you can enable permissive mode for this invocation.',
      specRef: 'failure-modes.md FM-T3; resolutions.md R4; ADR-008',
    });
  }
}

/**
 * FM-T1, FM-T2, INV-T5: Tool was terminated by a signal (SIGSEGV,
 * SIGKILL, etc.). Distinct from an exit code.
 */
export class SignalTerminated extends ToolInvocationError {
  readonly kind = 'signal_terminated';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    signalName: string;
    signalNumber: number;
    likelyCause?: 'out_of_memory' | 'wall_time_exceeded';
    stderr: string;
    caseId?: CaseId;
    jobId?: JobId;
  }) {
    const causeHint = props.likelyCause === 'out_of_memory'
      ? 'Consider requesting more memory or processing the data in smaller chunks.'
      : props.likelyCause === 'wall_time_exceeded'
        ? 'Consider resubmitting with a longer wall time.'
        : 'This indicates a real defect, not a transient error.';
    super({
      userMessage: `Tool was killed by signal ${props.signalName} (${props.signalNumber}). ${causeHint}`,
      internalDetails: `Signal ${props.signalName} (${props.signalNumber}), stderr: ${props.stderr}`,
      recoveryHint: causeHint,
      specRef: 'invariants.md INV-T5; failure-modes.md FM-T1, FM-T2',
    });
  }
}

/**
 * FM-D1: Filesystem quota exceeded.
 */
export class QuotaExceeded extends ToolInvocationError {
  readonly kind = 'quota_exceeded';
  readonly severity = 'HIGH' as const;
}

/**
 * FM-D4: Two ToolInvocations attempt to write to the same output
 * Location simultaneously.
 */
export class ConcurrentWriteConflict extends ToolInvocationError {
  readonly kind = 'concurrent_write_conflict';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    path: string;
    existingInvocationId: ToolInvocationId;
  }) {
    super({
      userMessage: `Another ToolInvocation (${props.existingInvocationId}) is already writing to '${props.path}'. The second ToolInvocation has been refused.`,
      internalDetails: `Write conflict at ${props.path}, existing: ${props.existingInvocationId}`,
      recoveryHint: 'Wait for the existing ToolInvocation to complete or choose a different output path.',
      specRef: 'failure-modes.md FM-D4',
    });
  }
}

/**
 * FM-D5: A Dataset (e.g., ZARR store) is corrupted.
 */
export class CorruptedDataset extends ToolInvocationError {
  readonly kind = 'corrupted_dataset';
  readonly severity = 'HIGH' as const;
}

/**
 * INV-T6 (formerly INV-M1): Cannot submit a Case that is not in
 * BUILT state.
 */
export class CaseNotBuilt extends ToolInvocationError {
  readonly kind = 'case_not_built';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { caseId: CaseId; currentState: string }) {
    super({
      userMessage: `Cannot submit Case '${props.caseId}' — it is in ${props.currentState} state, not BUILT.`,
      internalDetails: `Case ${props.caseId} state: ${props.currentState}`,
      recoveryHint: 'Build the Case before submitting.',
      specRef: 'invariants.md INV-T6; ADR-001',
    });
  }
}

/**
 * INV-T7 (formerly INV-M2): A Case already has a RUNNING Job.
 */
export class CaseAlreadyRunning extends ToolInvocationError {
  readonly kind = 'case_already_running';
  readonly severity = 'HIGH' as const;

  constructor(props: { caseId: CaseId; jobId: JobId }) {
    super({
      userMessage: `Case '${props.caseId}' already has a RUNNING Job (${props.jobId}). Resubmission requires the prior Job to reach a terminal state.`,
      internalDetails: `Case ${props.caseId} has running Job ${props.jobId}`,
      recoveryHint: 'Wait for the current Job to complete or cancel it before resubmitting.',
      specRef: 'invariants.md INV-T7; ADR-001',
    });
  }
}

/**
 * INV-T8 (formerly INV-M3): Run length exceeds Wall Time.
 */
export class RunLengthExceedsWallTime extends ToolInvocationError {
  readonly kind = 'run_length_exceeds_wall_time';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { caseId: CaseId; runLength: string; wallTime: string }) {
    super({
      userMessage: `Run length (${props.runLength}) exceeds Wall Time (${props.wallTime}) for Case '${props.caseId}'. The model will be killed mid-run.`,
      internalDetails: `Case ${props.caseId}: runLength ${props.runLength} > wallTime ${props.wallTime}`,
      recoveryHint: 'Increase the Wall Time or reduce the run length.',
      specRef: 'invariants.md INV-T8; ADR-001',
    });
  }
}

/**
 * INV-T9 (formerly INV-M4): Output tree Location is not set.
 * Satisfied at Case creation per R5 — this error should not occur
 * in normal operation.
 */
export class OutputLocationNotSet extends ToolInvocationError {
  readonly kind = 'output_location_not_set';
  readonly severity = 'HIGH' as const;

  constructor(props: { caseId: CaseId }) {
    super({
      userMessage: `Output tree Location is not set for Case '${props.caseId}'.`,
      internalDetails: `Case ${props.caseId} has no outputTreeLocation`,
      recoveryHint: 'This should not occur — the output location is set at Case creation (R5). Report as a bug.',
      specRef: 'invariants.md INV-T9; resolutions.md R5',
    });
  }
}

// ============================================================================
// SchedulingError (C4 — SLURM)
// ============================================================================

export abstract class SchedulingError extends CeraError {
  readonly kind: string = 'scheduling';
}

/**
 * FM-S1: SLURM rejected the Job at submission.
 */
export class RejectedByScheduler extends SchedulingError {
  readonly kind = 'rejected_by_scheduler';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    resourceRequest: ResourceRequest;
    slurmError: string;
  }) {
    super({
      userMessage: `SLURM rejected the Job submission: ${props.slurmError}. No Job was created.`,
      internalDetails: `sbatch rejection: ${props.slurmError}`,
      recoveryHint: 'Check the ResourceRequest (partition, QoS, node count, wall time) and adjust accordingly.',
      specRef: 'failure-modes.md FM-S1',
    });
  }
}

/**
 * FM-S2, R13: SLURM is unreachable. All Job states marked UNKNOWN.
 */
export class SchedulerUnavailable extends SchedulingError {
  readonly kind = 'scheduler_unavailable';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { command: string; error: string }) {
    super({
      userMessage: `SLURM is currently unreachable. All Job states are marked as UNKNOWN. Running Jobs on compute nodes are NOT affected. The Agent is retrying with backoff.`,
      internalDetails: `${props.command} failed: ${props.error}`,
      recoveryHint: 'UNKNOWN is acceptable for up to 30 minutes. The Agent reconciles via sacct when SLURM recovers.',
      specRef: 'failure-modes.md FM-S2; resolutions.md R13',
    });
  }
}

/**
 * FM-S3: Stale queue data from squeue.
 */
export class StaleQueueData extends SchedulingError {
  readonly kind = 'stale_queue_data';
  readonly severity = 'MEDIUM' as const;

  constructor(props: {
    jobId: JobId;
    reportedState: string;
    actualState?: string;
  }) {
    super({
      userMessage: '', // transparent to User
      internalDetails: `Job ${props.jobId}: squeue reported ${props.reportedState}, actual: ${props.actualState ?? 'unknown'}`,
      recoveryHint: 'Query sacct for authoritative data.',
      specRef: 'failure-modes.md FM-S3; invariants.md INV-S1, INV-S4',
    });
  }
}

/**
 * Job does not exist in SLURM.
 */
export class JobNotFound extends SchedulingError {
  readonly kind = 'job_not_found';
  readonly severity = 'MEDIUM' as const;
}

// ============================================================================
// EnvironmentError (C5 — uenv)
// ============================================================================

export abstract class EnvironmentError extends CeraError {
  readonly kind: string = 'environment';
}

/**
 * FM-E1: uenv not found in the registry.
 */
export class UenvNotFound extends EnvironmentError {
  readonly kind = 'uenv_not_found';
  readonly severity = 'HIGH' as const;

  constructor(props: { name: string; version: string }) {
    super({
      userMessage: `uenv '${props.name}/${props.version}' is not available on this host.`,
      internalDetails: `uenv ${props.name}/${props.version} not in registry`,
      recoveryHint: 'Check the uenv name and version, or load an alternative.',
      specRef: 'invariants.md INV-E3; resolutions.md R9; failure-modes.md FM-E1',
    });
  }
}

/**
 * FM-E2, INV-E2: Conflict between uenvs at the filesystem path
 * level.
 */
export class ConflictDetected extends EnvironmentError {
  readonly kind = 'conflict_detected';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { conflict: Conflict }) {
    super({
      userMessage: `Conflict detected between uenvs: both provide '${props.conflict.conflictPath}' (${props.conflict.conflictType}). Only one Environment may be active per execution context.`,
      internalDetails: `Conflict: ${props.conflict.description}`,
      recoveryHint: 'Purge the current Environment and load the desired one.',
      specRef: 'invariants.md INV-E1, INV-E2; resolutions.md R9; failure-modes.md FM-E2',
    });
  }
}

/**
 * FM-E3: Partial uenv mount — some paths loaded, others failed.
 */
export class PartialLoad extends EnvironmentError {
  readonly kind = 'partial_load';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    loadedPaths: string[];
    failedPaths: string[];
    error: string;
  }) {
    super({
      userMessage: `Partial uenv mount: some paths loaded successfully, but others failed. The Environment has been purged and is NOT active.`,
      internalDetails: `Loaded: ${props.loadedPaths.join(', ')}. Failed: ${props.failedPaths.join(', ')}. Error: ${props.error}`,
      recoveryHint: 'Retry or choose an alternative uenv.',
      specRef: 'resolutions.md R9; failure-modes.md FM-E3',
    });
  }
}

/**
 * Environment is no longer active (purged or replaced by another
 * process between load and invocation).
 */
export class NotActive extends EnvironmentError {
  readonly kind = 'not_active';
  readonly severity = 'HIGH' as const;
}

// ============================================================================
// DataError (C3)
// ============================================================================

export abstract class DataError extends CeraError {
  readonly kind: string = 'data';
}

export class LocationNotReadable extends DataError {
  readonly kind = 'location_not_readable';
  readonly severity = 'HIGH' as const;
  readonly cause: 'enoent' | 'eacces' | 'slow';

  constructor(props: { path: string; cause: 'enoent' | 'eacces' | 'slow' }) {
    super({
      userMessage: `Dataset location '${props.path}' could not be read: ${props.cause}.`,
      internalDetails: `Location ${props.path}: ${props.cause}`,
      recoveryHint: 'Verify the path or select a different Dataset.',
      specRef: 'invariants.md INV-D4; failure-modes.md FM-D3',
    });
    this.cause = props.cause;
  }
}

export class LocationNotWritable extends DataError {
  readonly kind = 'location_not_writable';
  readonly severity = 'HIGH' as const;
  readonly cause: 'enoent' | 'eacces' | 'slow';

  constructor(props: { path: string; cause: 'enoent' | 'eacces' | 'slow' }) {
    super({
      userMessage: `Dataset location '${props.path}' could not be written: ${props.cause}.`,
      internalDetails: `Location ${props.path}: ${props.cause}`,
      recoveryHint: 'Verify the path, permissions, or available quota.',
      specRef: 'invariants.md INV-D4; failure-modes.md FM-D3',
    });
    this.cause = props.cause;
  }
}

export class DataQuotaExceeded extends DataError {
  readonly kind = 'data_quota_exceeded';
  readonly severity = 'HIGH' as const;

  constructor(props: { path: string; filesystem: string }) {
    super({
      userMessage: `Filesystem quota exceeded on ${props.filesystem}. The output write failed. No output has been registered.`,
      internalDetails: `ENOSPC at ${props.path} on ${props.filesystem}`,
      recoveryHint: 'Clean up old Datasets or temporary files, or request more quota.',
      specRef: 'failure-modes.md FM-D1',
    });
  }
}

export class ProvenanceMissing extends DataError {
  readonly kind = 'provenance_missing';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { datasetId: DatasetId; workflowStepId?: string }) {
    super({
      userMessage: `Dataset '${props.datasetId}' has no ProvenanceRecord and cannot be consumed.`,
      internalDetails: `Dataset ${props.datasetId} has no ProvenanceRecord`,
      recoveryHint: 'Provide the missing Provenance information manually or regenerate the Dataset.',
      specRef: 'invariants.md INV-D3, INV-P3, INV-W1; failure-modes.md FM-P3',
    });
  }
}

export class DatasetCorrupted extends DataError {
  readonly kind = 'dataset_corrupted';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    datasetId: DatasetId;
    path: string;
    corruptionType: string;
  }) {
    super({
      userMessage: `Dataset '${props.datasetId}' at '${props.path}' is corrupted: ${props.corruptionType}. The Dataset has been quarantined.`,
      internalDetails: `Dataset ${props.datasetId} corruption: ${props.corruptionType}`,
      recoveryHint: 'The ProvenanceRecord (if available) identifies the ToolInvocation that created this store.',
      specRef: 'failure-modes.md FM-D5, FM-X5',
    });
  }
}

// ============================================================================
// ProvenanceError (C6)
// ============================================================================

export abstract class ProvenanceError extends CeraError {
  readonly kind: string = 'provenance';
}

/**
 * FM-P1: ProvenanceRecord write failed.
 */
export class WriteFailed extends ProvenanceError {
  readonly kind = 'write_failed';
  readonly severity = 'CRITICAL' as const;

  constructor(props: {
    datasetId: DatasetId;
    error: string;
    retryCount: number;
  }) {
    super({
      userMessage: `Failed to write ProvenanceRecord for Dataset '${props.datasetId}' after ${props.retryCount} retries. The Dataset has NOT been registered as available.`,
      internalDetails: `Write failed: ${props.error}, retries: ${props.retryCount}`,
      recoveryHint: 'Without Provenance, the Dataset is not scientifically valid.',
      specRef: 'invariants.md INV-P1, INV-D3; failure-modes.md FM-P1',
    });
  }
}

/**
 * FM-P2, R11: ProvenanceRecord is corrupted. Local — only the
 * affected Dataset is quarantined, not the entire store.
 */
export class RecordCorrupted extends ProvenanceError {
  readonly kind = 'record_corrupted';
  readonly severity = 'CRITICAL' as const;

  constructor(props: {
    datasetId: DatasetId;
    corruptionType: string;
  }) {
    super({
      userMessage: `The ProvenanceRecord for Dataset '${props.datasetId}' is corrupted (${props.corruptionType}). The Dataset has been quarantined. Other Datasets remain available.`,
      internalDetails: `Corruption type: ${props.corruptionType}`,
      recoveryHint: 'The Agent is attempting to reconstruct the record from available metadata.',
      specRef: 'resolutions.md R11; failure-modes.md FM-P2',
    });
  }
}

/**
 * INV-P2: ProvenanceRecord is missing a required field.
 */
export class MissingField extends ProvenanceError {
  readonly kind = 'missing_field';
  readonly severity = 'CRITICAL' as const;

  constructor(props: { field: string; recordId?: string }) {
    super({
      userMessage: `A ProvenanceRecord is missing required field '${props.field}'. The record is defective.`,
      internalDetails: `Missing field: ${props.field}${props.recordId ? ` in record ${props.recordId}` : ''}`,
      recoveryHint: 'A record missing any field is defective and must be corrected.',
      specRef: 'invariants.md INV-P2',
    });
  }
}

// ============================================================================
// AgentError (C7)
// ============================================================================

export abstract class AgentError extends CeraError {
  readonly kind: string = 'agent';
}

/**
 * FM-A1, R12: LLM hallucinated a Tool name. Refuse and ask.
 */
export class LlmHallucinatedTool extends AgentError {
  readonly kind = 'llm_hallucinated_tool';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    requestedTool: string;
    availableTools: ToolId[];
  }) {
    super({
      userMessage: `The Tool '${props.requestedTool}' is not in the catalog. Available Tools: ${props.availableTools.join(', ')}. Please clarify which Tool you would like to use.`,
      internalDetails: `LLM requested '${props.requestedTool}', not in catalog.`,
      recoveryHint: 'Select a Tool from the available list.',
      specRef: 'failure-modes.md FM-A1; resolutions.md R12; ADR-010',
    });
  }
}

/**
 * FM-A2, R12: LLM hallucinated parameters. Refuse and ask.
 */
export class LlmHallucinatedParameters extends AgentError {
  readonly kind = 'llm_hallucinated_parameters';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    toolId: ToolId;
    invalidParameters: string[];
    schema: unknown;
  }) {
    super({
      userMessage: `The parameters ${props.invalidParameters.join(', ')} for Tool '${props.toolId}' are invalid. Please check the parameter values.`,
      internalDetails: `Tool ${props.toolId}: invalid parameters ${props.invalidParameters.join(', ')}`,
      recoveryHint: 'Check the parameter values against the Tool schema and the input Dataset metadata.',
      specRef: 'failure-modes.md FM-A2; resolutions.md R12; ADR-010',
    });
  }
}

/**
 * FM-A3: Context window exceeded. Degradable — summarize, compact,
 * or start a new Session.
 */
export class ContextWindowExceeded extends AgentError {
  readonly kind = 'context_window_exceeded';
  readonly severity = 'MEDIUM' as const;

  constructor(props: { tokenCount: number; limit: number }) {
    super({
      userMessage: `The Session context has been compacted to fit within the model's context window (${props.tokenCount} → ${props.limit} tokens). Running Jobs and ProvenanceRecords are preserved.`,
      internalDetails: `Token count ${props.tokenCount} exceeded limit ${props.limit}`,
      recoveryHint: 'If you need more detail, consider starting a new Session.',
      specRef: 'failure-modes.md FM-A3',
    });
  }
}

/**
 * FM-A4: LLM is unavailable. Running Jobs continue.
 */
export class LlmUnavailable extends AgentError {
  readonly kind = 'llm_unavailable';
  readonly severity = 'HIGH' as const;

  constructor(props: { error: string; retryCount: number }) {
    super({
      userMessage: `The language model is currently unavailable. Running Jobs and ToolInvocations on the HPC are NOT affected. The Agent is retrying with backoff.`,
      internalDetails: `LLM error: ${props.error}, retries: ${props.retryCount}`,
      recoveryHint: 'You can continue to query Job and Dataset status.',
      specRef: 'failure-modes.md FM-A4',
    });
  }
}

/**
 * FM-X2: Login node network loss.
 */
export class NetworkLost extends AgentError {
  readonly kind = 'network_lost';
  readonly severity = 'HIGH' as const;

  constructor(props: { node: string }) {
    super({
      userMessage: `Network connectivity has been lost on the login node. Running Jobs on compute nodes are NOT affected.`,
      internalDetails: `Network lost on ${props.node}`,
      recoveryHint: 'The Agent cannot reach the LLM, SLURM, or remote Datasets until network is restored.',
      specRef: 'failure-modes.md FM-X2',
    });
  }
}

/**
 * R2: Workflow is already assigned to another Experiment.
 */
export class WorkflowAlreadyAssigned extends AgentError {
  readonly kind = 'workflow_already_assigned';
  readonly severity = 'MEDIUM' as const;

  constructor(props: {
    workflowId: string;
    existingExperimentId: string;
  }) {
    super({
      userMessage: `Workflow '${props.workflowId}' is already assigned to Experiment '${props.existingExperimentId}'.`,
      internalDetails: `Workflow ${props.workflowId} assigned to ${props.existingExperimentId}`,
      recoveryHint: 'A Workflow belongs to exactly one Experiment.',
      specRef: 'resolutions.md R2; ADR-002',
    });
  }
}

/**
 * R2: An Experiment does not exist when a Workflow or Case is
 * being assigned to it. Used by agent-interaction (C7) which
 * validates experimentId asynchronously — the Case is created in
 * C1 without validation, and agent-interaction later calls
 * addCaseToExperiment() which throws if the Experiment does not
 * exist (eventual consistency, per FINDING-02 resolution).
 */
export class ExperimentNotFound extends AgentError {
  readonly kind = 'experiment_not_found';
  readonly severity = 'HIGH' as const;

  constructor(props: {
    experimentId: string;
    caseId?: CaseId;
    workflowId?: string;
  }) {
    const context = props.caseId
      ? `Case '${props.caseId}'`
      : props.workflowId
        ? `Workflow '${props.workflowId}'`
        : 'entity';
    super({
      userMessage: `${context} references Experiment '${props.experimentId}', which does not exist. The Experiment must be created before Workflows and Cases can be assigned to it.`,
      internalDetails: `${context} -> Experiment ${props.experimentId} (not found)`,
      recoveryHint: 'Create the Experiment first, then assign Workflows and Cases to it.',
      specRef: 'resolutions.md R2; ADR-002; FINDING-02 (eventual consistency)',
    });
  }
}

/**
 * R2: A Case is already assigned to another Experiment. Thrown by
 * agent-interaction.addCaseToExperiment() when the Case's
 * experimentId does not match the requested Experiment (eventual
 * consistency, per FINDING-02 resolution).
 */
export class CaseAlreadyAssigned extends AgentError {
  readonly kind = 'case_already_assigned';
  readonly severity = 'MEDIUM' as const;

  constructor(props: {
    caseId: CaseId;
    requestedExperimentId: string;
    existingExperimentId: string;
  }) {
    super({
      userMessage: `Case '${props.caseId}' is already assigned to Experiment '${props.existingExperimentId}', not '${props.requestedExperimentId}'.`,
      internalDetails: `Case ${props.caseId}: requested ${props.requestedExperimentId}, existing ${props.existingExperimentId}`,
      recoveryHint: 'A Case belongs to exactly one Experiment. Use the existing Experiment or create a new Case.',
      specRef: 'resolutions.md R2; ADR-002; FINDING-02 (eventual consistency)',
    });
  }
}
