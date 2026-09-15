/**
 * Event types for cera.
 *
 * These are STUBS — type definitions only, no implementation.
 * Each event is a discriminated union. Events are produced by
 * modules and consumed by modules that depend on them, as
 * specified in api-contracts.md.
 *
 * Spec references: api-contracts.md (events produced/consumed per
 * module), cross-context/interactions.md, resolutions.md.
 */

import type {
  DatasetId,
  EnvironmentId,
  JobId,
  ToolId,
  ToolInvocationId,
  CaseId,
  WorkflowId,
  WorkflowStepId,
  ExperimentId,
  SessionId,
  ProvenanceRecordId,
  JobState,
  WorkflowState,
  ExitOutcome,
  UenvSpec,
  Conflict,
} from './value-objects';

// ============================================================================
// ToolInvocationEvent (C1)
// ============================================================================

/**
 * Events produced by the tool-invocation module.
 *
 * Spec: api-contracts.md §6 (tool-invocation).
 */
export type ToolInvocationEvent =
  | ToolInvocationCreated
  | ToolInvocationStarted
  | ToolInvocationCompleted
  | ToolInvocationFailed
  | ToolInvocationSignalTerminated;

export interface ToolInvocationCreated {
  readonly kind: 'tool_invocation_created';
  readonly invocationId: ToolInvocationId;
  readonly toolId: ToolId;
  readonly inputDatasetIds: readonly DatasetId[];
  readonly timestamp: Date;
}

export interface ToolInvocationStarted {
  readonly kind: 'tool_invocation_started';
  readonly invocationId: ToolInvocationId;
  readonly environmentId: EnvironmentId;
  readonly executionModel: 'synchronous' | 'parallel';
  readonly jobId?: JobId;
  readonly timestamp: Date;
}

export interface ToolInvocationCompleted {
  readonly kind: 'tool_invocation_completed';
  readonly invocationId: ToolInvocationId;
  readonly exitOutcome: ExitOutcome;
  readonly outputDatasetIds: readonly DatasetId[];
  readonly provenanceRecordId: ProvenanceRecordId;
  readonly timestamp: Date;
}

export interface ToolInvocationFailed {
  readonly kind: 'tool_invocation_failed';
  readonly invocationId: ToolInvocationId;
  readonly exitOutcome: ExitOutcome;
  readonly stderr: string;
  readonly timestamp: Date;
}

export interface ToolInvocationSignalTerminated {
  readonly kind: 'tool_invocation_signal_terminated';
  readonly invocationId: ToolInvocationId;
  readonly signalName: string;
  readonly signalNumber: number;
  readonly stderr: string;
  readonly timestamp: Date;
}

// ============================================================================
// JobEvent (C4 — SLURM)
// ============================================================================

/**
 * Events produced by the scheduling module.
 *
 * Spec: api-contracts.md §2 (scheduling); invariants.md INV-S1, INV-S4.
 */
export type JobEvent =
  | JobSubmitted
  | JobStateChanged
  | JobCancelled
  | JobTimeout
  | JobNodeFail
  | JobUnknown;

export interface JobSubmitted {
  readonly kind: 'job_submitted';
  readonly jobId: JobId;
  readonly caseId?: CaseId;
  readonly workflowId?: WorkflowId;
  readonly resourceRequestHash: string;
  readonly timestamp: Date;
}

export interface JobStateChanged {
  readonly kind: 'job_state_changed';
  readonly jobId: JobId;
  readonly previousState: JobState;
  readonly newState: JobState;
  readonly source: 'squeue' | 'sacct';
  readonly timestamp: Date;
}

export interface JobCancelled {
  readonly kind: 'job_cancelled';
  readonly jobId: JobId;
  readonly by: 'user' | 'agent' | 'system';
  readonly timestamp: Date;
}

export interface JobTimeout {
  readonly kind: 'job_timeout';
  readonly jobId: JobId;
  readonly caseId?: CaseId;
  readonly wallTime: string;
  readonly timestamp: Date;
}

export interface JobNodeFail {
  readonly kind: 'job_node_fail';
  readonly jobId: JobId;
  readonly caseId?: CaseId;
  readonly failedNodes: readonly string[];
  readonly timestamp: Date;
}

export interface JobUnknown {
  readonly kind: 'job_unknown';
  readonly jobId: JobId;
  readonly reason: string;
  readonly retryAfterMs: number;
  readonly timestamp: Date;
}

// ============================================================================
// DatasetEvent (C3)
// ============================================================================

/**
 * Events produced by the data-management module.
 *
 * Spec: api-contracts.md §5 (data-management); invariants.md INV-D1–D4.
 */
export type DatasetEvent =
  | DatasetRegistered
  | DatasetConsumable
  | DatasetQuarantined
  | DatasetLocationInvalid;

export interface DatasetRegistered {
  readonly kind: 'dataset_registered';
  readonly datasetId: DatasetId;
  readonly name: string;
  readonly format: string;
  readonly gridKind: string;
  readonly producerToolInvocationId: ToolInvocationId | null;
  readonly timestamp: Date;
}

export interface DatasetConsumable {
  readonly kind: 'dataset_consumable';
  readonly datasetId: DatasetId;
  readonly provenanceRecordId: ProvenanceRecordId;
  readonly timestamp: Date;
}

export interface DatasetQuarantined {
  readonly kind: 'dataset_quarantined';
  readonly datasetId: DatasetId;
  readonly reason: string;
  readonly timestamp: Date;
}

export interface DatasetLocationInvalid {
  readonly kind: 'dataset_location_invalid';
  readonly datasetId: DatasetId;
  readonly path: string;
  readonly cause: 'enoent' | 'eacces' | 'slow';
  readonly timestamp: Date;
}

// ============================================================================
// ProvenanceEvent (C6)
// ============================================================================

/**
 * Events produced by the provenance module.
 *
 * Spec: api-contracts.md §4 (provenance); invariants.md INV-P1–P4;
 * resolutions.md R11 (local corruption).
 */
export type ProvenanceEvent =
  | ProvenanceRecordWritten
  | ProvenanceRecordCorrupted
  | ProvenanceRecordReconstructed
  | ProvenanceDatasetQuarantined;

export interface ProvenanceRecordWritten {
  readonly kind: 'provenance_record_written';
  readonly recordId: ProvenanceRecordId;
  readonly datasetId: DatasetId;
  readonly toolId: ToolId;
  readonly timestamp: Date;
}

export interface ProvenanceRecordCorrupted {
  readonly kind: 'provenance_record_corrupted';
  readonly recordId: ProvenanceRecordId;
  readonly datasetId: DatasetId;
  readonly corruptionType: string;
  readonly timestamp: Date;
}

export interface ProvenanceRecordReconstructed {
  readonly kind: 'provenance_record_reconstructed';
  readonly recordId: ProvenanceRecordId;
  readonly datasetId: DatasetId;
  readonly source: 'tool_invocation_logs' | 'environment_state' | 'partial_record';
  readonly timestamp: Date;
}

export interface ProvenanceDatasetQuarantined {
  readonly kind: 'provenance_dataset_quarantined';
  readonly datasetId: DatasetId;
  readonly reason: string;
  readonly timestamp: Date;
}

// ============================================================================
// WorkflowEvent (C7)
// ============================================================================

/**
 * Events produced by the agent-interaction module (Workflow).
 *
 * Spec: api-contracts.md §7 (Workflow); invariants.md INV-W1–W4;
 * resolutions.md R6 (first-class, persisted).
 */
export type WorkflowEvent =
  | WorkflowCreated
  | WorkflowStepStarted
  | WorkflowStepCompleted
  | WorkflowStepFailed
  | WorkflowStateChanged
  | WorkflowResumed;

export interface WorkflowCreated {
  readonly kind: 'workflow_created';
  readonly workflowId: WorkflowId;
  readonly experimentId: ExperimentId;
  readonly name: string;
  readonly timestamp: Date;
}

export interface WorkflowStepStarted {
  readonly kind: 'workflow_step_started';
  readonly workflowId: WorkflowId;
  readonly stepId: WorkflowStepId;
  readonly order: number;
  readonly toolId: ToolId;
  readonly timestamp: Date;
}

export interface WorkflowStepCompleted {
  readonly kind: 'workflow_step_completed';
  readonly workflowId: WorkflowId;
  readonly stepId: WorkflowStepId;
  readonly outputDatasetId: DatasetId;
  readonly timestamp: Date;
}

export interface WorkflowStepFailed {
  readonly kind: 'workflow_step_failed';
  readonly workflowId: WorkflowId;
  readonly stepId: WorkflowStepId;
  readonly exitOutcome: ExitOutcome;
  readonly downstreamHalted: boolean;
  readonly timestamp: Date;
}

export interface WorkflowStateChanged {
  readonly kind: 'workflow_state_changed';
  readonly workflowId: WorkflowId;
  readonly previousState: WorkflowState;
  readonly newState: WorkflowState;
  readonly timestamp: Date;
}

export interface WorkflowResumed {
  readonly kind: 'workflow_resumed';
  readonly workflowId: WorkflowId;
  readonly fromState: WorkflowState;
  readonly sessionId: SessionId;
  readonly timestamp: Date;
}

// ============================================================================
// SessionEvent (C7)
// ============================================================================

/**
 * Events produced by the agent-interaction module (Session).
 *
 * Spec: api-contracts.md §7 (Session); resolutions.md R7 (proactive
 * Job reporting on start).
 */
export type SessionEvent =
  | SessionStarted
  | SessionProactiveJobReport
  | SessionEnded;

export interface SessionStarted {
  readonly kind: 'session_started';
  readonly sessionId: SessionId;
  readonly userId: string;
  readonly timestamp: Date;
}

export interface SessionProactiveJobReport {
  readonly kind: 'session_proactive_job_report';
  readonly sessionId: SessionId;
  readonly jobReports: readonly {
    readonly jobId: JobId;
    readonly state: JobState;
    readonly caseId?: CaseId;
    readonly workflowId?: WorkflowId;
    readonly message?: string;
  }[];
  readonly timestamp: Date;
}

export interface SessionEnded {
  readonly kind: 'session_ended';
  readonly sessionId: SessionId;
  readonly runningJobsPreserved: boolean;
  readonly timestamp: Date;
}

// ============================================================================
// ExperimentEvent (C7)
// ============================================================================

/**
 * Events produced by the agent-interaction module (Experiment).
 *
 * Spec: api-contracts.md §7 (Experiment); resolutions.md R2;
 * ADR-002.
 */
export type ExperimentEvent =
  | ExperimentCreated
  | ExperimentWorkflowAdded
  | ExperimentCaseAdded;

export interface ExperimentCreated {
  readonly kind: 'experiment_created';
  readonly experimentId: ExperimentId;
  readonly name: string;
  readonly researchQuestion: string;
  readonly timestamp: Date;
}

export interface ExperimentWorkflowAdded {
  readonly kind: 'experiment_workflow_added';
  readonly experimentId: ExperimentId;
  readonly workflowId: WorkflowId;
  readonly timestamp: Date;
}

export interface ExperimentCaseAdded {
  readonly kind: 'experiment_case_added';
  readonly experimentId: ExperimentId;
  readonly caseId: CaseId;
  readonly timestamp: Date;
}

// ============================================================================
// EnvironmentEvent (C5 — uenv)
// ============================================================================

/**
 * Events produced by the environment-management module.
 *
 * Spec: api-contracts.md §3 (environment-management); invariants.md
 * INV-E1–E3 (updated for uenv); resolutions.md R9; ADR-003.
 */
export type EnvironmentEvent =
  | EnvironmentLoaded
  | EnvironmentUnloaded
  | EnvironmentConflictDetected
  | EnvironmentVerificationFailed;

export interface EnvironmentLoaded {
  readonly kind: 'environment_loaded';
  readonly environmentId: EnvironmentId;
  readonly uenvSpecs: readonly UenvSpec[];
  readonly conflictFree: boolean;
  readonly timestamp: Date;
}

export interface EnvironmentUnloaded {
  readonly kind: 'environment_unloaded';
  readonly environmentId: EnvironmentId;
  readonly reason: 'user_requested' | 'conflict' | 'session_end';
  readonly timestamp: Date;
}

export interface EnvironmentConflictDetected {
  readonly kind: 'environment_conflict_detected';
  readonly conflict: Conflict;
  readonly timestamp: Date;
}

export interface EnvironmentVerificationFailed {
  readonly kind: 'environment_verification_failed';
  readonly environmentId: EnvironmentId;
  readonly reason: 'not_active' | 'conflict_appeared' | 'partial_mount';
  readonly timestamp: Date;
}

// ============================================================================
// All Events Union
// ============================================================================

/**
 * Union of all cera events. Used by the event bus / dsh-adapter
 * to route events between modules.
 */
export type CeraEvent =
  | ToolInvocationEvent
  | JobEvent
  | DatasetEvent
  | ProvenanceEvent
  | WorkflowEvent
  | SessionEvent
  | ExperimentEvent
  | EnvironmentEvent;
