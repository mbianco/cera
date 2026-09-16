/**
 * Public types for the agent-interaction module (C7).
 *
 * This module provides the full LLM-facing surface: Session,
 * Experiment, Workflow, and Action. It is the final implementation
 * phase (Phase 5), depending on tool-invocation (Phase 4),
 * data-management (Phase 3), provenance (Phase 2), and scheduling
 * (Phase 2).
 *
 * Invariants enforced:
 * - INV-W1: Step inputs exist before step starts.
 * - INV-W2: Failure halts downstream.
 * - INV-W3: Workflow describes real dependencies (best-effort).
 * - INV-W4: Session can outlive its Jobs' completion.
 *
 * Failure modes handled:
 * - FM-A1: LLM hallucinates Tool name → refuse and ask (R12).
 * - FM-A2: LLM hallucinates parameters → refuse and ask (R12).
 * - FM-A3: Context window exceeded (degradable).
 * - FM-A4: LLM unavailable (degradable).
 *
 * Spec references: api-contracts.md §7; module-graph.md §7;
 * invariants.md INV-W1–W4; failure-modes.md FM-A1–A4;
 * resolutions.md R2, R3, R6, R7, R12; ADR-002, ADR-006,
 * ADR-007, ADR-010.
 */

import type {
  ActionId,
  CaseId,
  DatasetId,
  ExperimentId,
  JobId,
  JobState,
  Location,
  ResourceRequest,
  SessionId,
  ToolId,
  WorkflowId,
  WorkflowStepId,
} from '../types';
import type { ToolInvocationRequest } from '../tool-invocation/types';

// ============================================================================
// JobStatusReport
// ============================================================================

/**
 * A human-readable Job status report, used by SessionService for
 * proactive Job reporting on Session start (R7, ADR-007) and
 * on-demand queries.
 *
 * The `caseId` and `workflowId` fields are optional because a Job
 * may not be associated with a Case or Workflow (e.g., a standalone
 * CDO remap submitted directly via scheduling).
 *
 * Spec: api-contracts.md §7 (JobStatusReport).
 */
export interface JobStatusReport {
  readonly jobId: JobId;
  readonly state: JobState;
  readonly caseId?: CaseId;
  readonly workflowId?: WorkflowId;
  readonly message?: string;
}

// ============================================================================
// SessionService types
// ============================================================================

/**
 * Configuration for the SessionService.
 *
 * `proactiveJobReportTimeoutMs` — maximum time (milliseconds) to wait
 * for `scheduling.queryJobsByUser()` before reporting that Job states
 * are being retrieved asynchronously. Default: 10_000 (10 seconds,
 * per ADR-007).
 *
 * Spec: ADR-007.
 */
export interface SessionServiceConfig {
  readonly proactiveJobReportTimeoutMs: number;
}

/**
 * Default SessionService configuration per ADR-007.
 */
export const DEFAULT_SESSION_SERVICE_CONFIG: SessionServiceConfig = {
  proactiveJobReportTimeoutMs: 10_000,
};

// ============================================================================
// ExperimentService types
// ============================================================================

/**
 * Input for creating a new Experiment. An Experiment groups Workflows
 * and CESM Cases by a research question (R2, ADR-002).
 *
 * Spec: api-contracts.md §7 (CreateExperimentInput).
 */
export interface CreateExperimentInput {
  readonly name: string;
  readonly researchQuestion: string;
}

/**
 * Optional filter for `queryExperiments()`. All specified fields
 * must match (AND semantics). Unspecified fields are not filtered.
 *
 * `name` matching is exact (case-sensitive).
 *
 * Spec: api-contracts.md §7 (ExperimentFilter).
 */
export interface ExperimentFilter {
  readonly name?: string;
}

// ============================================================================
// WorkflowService types
// ============================================================================

/**
 * Input for creating a new Workflow. The Workflow belongs to exactly
 * one Experiment (R2).
 *
 * Spec: api-contracts.md §7 (CreateWorkflowInput).
 */
export interface CreateWorkflowInput {
  readonly name: string;
  readonly experimentId: ExperimentId;
}

/**
 * Input for adding a WorkflowStep to a Workflow. A WorkflowStep is
 * one Tool invocation or Case submission, with explicit input
 * Datasets and an optional output Dataset.
 *
 * `outputDatasetId` may not be known until the step runs — it is
 * optional. If provided, the WorkflowExecutor uses it to track the
 * output.
 *
 * `executionModel` defaults to 'synchronous' if not specified.
 *
 * Spec: api-contracts.md §7 (WorkflowStepInput).
 */
export interface WorkflowStepInput {
  readonly order: number;
  readonly name: string;
  readonly toolId: ToolId;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly DatasetId[];
  readonly outputDatasetId?: DatasetId;
  readonly executionModel?: 'synchronous' | 'parallel';
  readonly resourceRequest?: ResourceRequest;
}

/**
 * Configuration for the WorkflowService.
 *
 * `pollIntervalMs` — polling interval for parallel Job monitoring
 * during Workflow execution. Default: 30_000 (matches R13).
 * `outputBasePath` — default output Location for Workflow steps
 * that do not specify an output Dataset.
 *
 * Spec: ADR-006; resolutions.md R6, R13.
 */
export interface WorkflowServiceConfig {
  readonly pollIntervalMs: number;
  readonly outputBasePath: string;
  /**
   * Filesystem path for Workflow persistence (ADR-006).
   * Each Workflow is stored as `<storePath>/<workflow-id>.json`.
   * If empty, persistence is disabled (in-memory only, for testing).
   * Default: '/scratch/snx3000/cera_user/workflows'.
   */
  readonly storePath: string;
}

/**
 * Default WorkflowService configuration per ADR-006 and R13.
 */
export const DEFAULT_WORKFLOW_SERVICE_CONFIG: WorkflowServiceConfig = {
  pollIntervalMs: 30_000,
  outputBasePath: '/scratch/snx3000/cera_user/output',
  storePath: '/scratch/snx3000/cera_user/workflows',
};

// ============================================================================
// WorkflowExecutor types
// ============================================================================

/**
 * The result of executing a single WorkflowStep.
 *
 * - `completed`: the step finished successfully. `outputDatasetId`
 *   is set if the step produced an output.
 * - `failed`: the step failed (non-success ExitOutcome or Job
 *   reached a non-COMPLETED terminal State). `downstreamHalted`
 *   is always true (INV-W2).
 * - `blocked`: the step could not start because its input Datasets
 *   do not exist or lack Provenance (INV-W1). `missingInputs`
 *   lists the Datasets that failed verification.
 * - `waiting`: the step submitted a Job and is waiting for it to
 *   complete. `jobId` is the SLURM Job ID.
 */
export type StepExecutionResult =
  | {
      readonly kind: 'completed';
      readonly stepId: WorkflowStepId;
      readonly toolInvocationId?: string;
      readonly outputDatasetId?: DatasetId;
    }
  | {
      readonly kind: 'failed';
      readonly stepId: WorkflowStepId;
      readonly reason: string;
      readonly downstreamHalted: boolean;
    }
  | {
      readonly kind: 'blocked';
      readonly stepId: WorkflowStepId;
      readonly missingInputs: readonly {
        readonly datasetId: DatasetId;
        readonly reason: 'not_found' | 'no_provenance';
      }[];
    }
  | {
      readonly kind: 'waiting';
      readonly stepId: WorkflowStepId;
      readonly jobId: JobId;
    };

// ============================================================================
// ActionService types
// ============================================================================

/**
 * A request to validate and potentially execute an Action. The
 * `actionName` maps to a registered Action, which in turn maps to
 * a Tool in the catalog.
 *
 * Spec: api-contracts.md §7 (ActionRequest).
 */
export interface ActionRequest {
  readonly actionName: string;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly DatasetId[];
}

/**
 * The result of validating an Action request.
 *
 * - `valid`: the request is valid. `toolInvocationRequest` can be
 *   passed to `toolInvocation.invokeTool()`.
 * - `invalid`: validation failed (e.g., parameters do not match
 *   the schema). `reason` explains what went wrong; `suggestion`
 *   provides an optional hint.
 * - `refuseAndAsk`: the Tool name is not in the catalog (R12,
 *   ADR-010). The Agent refuses and asks the User for
 *   clarification. `availableTools` lists the Tools the User can
 *   choose from.
 *
 * Spec: api-contracts.md §7 (ActionResult); ADR-010.
 */
export type ActionResult =
  | { readonly valid: true; readonly toolInvocationRequest: ToolInvocationRequest }
  | { readonly valid: false; readonly reason: string; readonly suggestion?: string }
  | { readonly refuseAndAsk: true; readonly message: string; readonly availableTools: readonly ToolId[] };

// ============================================================================
// ActionService config
// ============================================================================

/**
 * Configuration for the ActionService.
 *
 * `outputBasePath` — default filesystem Location under which Action
 *   outputs are placed when the caller does not specify one. Each
 *   Action's output is at `<outputBasePath>/<actionName>.nc`.
 *
 * Spec: build-phases.md Phase 5; api-contracts.md §7 (ActionService).
 */
export interface ActionServiceConfig {
  readonly outputBasePath: string;
}

/**
 * Default ActionService configuration, matching the WorkflowService
 * default output base path (R13, ADR-006).
 */
export const DEFAULT_ACTION_SERVICE_CONFIG: ActionServiceConfig = {
  outputBasePath: '/scratch/snx3000/cera_user/output',
};

// ============================================================================
// AgentInteractionConfig (module-level)
// ============================================================================

/**
 * Configuration for the entire agent-interaction module.
 *
 * This is a convenience type that bundles the configurations for
 * all sub-services. Each sub-service also accepts its own config
 * individually.
 *
 * Spec: build-phases.md Phase 5.
 */
export interface AgentInteractionConfig {
  readonly session: SessionServiceConfig;
  readonly workflow: WorkflowServiceConfig;
  readonly action: ActionServiceConfig;
}

/**
 * Default module-level configuration.
 */
export const DEFAULT_AGENT_INTERACTION_CONFIG: AgentInteractionConfig = {
  session: DEFAULT_SESSION_SERVICE_CONFIG,
  workflow: DEFAULT_WORKFLOW_SERVICE_CONFIG,
  action: DEFAULT_ACTION_SERVICE_CONFIG,
};

// ============================================================================
// Branded ID helpers (internal to this module)
// ============================================================================

/**
 * Creates a SessionId from a string. Uses a type assertion because
 * the brand symbol is private to value-objects.ts.
 */
export function createSessionId(id: string): SessionId {
  return id as SessionId;
}

/**
 * Creates a UserId from a string.
 */
export function createUserId(id: string): import('../types').UserId {
  return id as import('../types').UserId;
}

/**
 * Creates an ExperimentId from a string.
 */
export function createExperimentId(id: string): ExperimentId {
  return id as ExperimentId;
}

/**
 * Creates a WorkflowId from a string.
 */
export function createWorkflowId(id: string): WorkflowId {
  return id as WorkflowId;
}

/**
 * Creates a WorkflowStepId from a string.
 */
export function createWorkflowStepId(id: string): WorkflowStepId {
  return id as WorkflowStepId;
}

/**
 * Creates an ActionId from a string.
 */
export function createActionId(id: string): ActionId {
  return id as ActionId;
}

/**
 * Creates a DatasetId from a string.
 */
export function createDatasetId(id: string): DatasetId {
  return id as DatasetId;
}

/**
 * Creates a ToolId from a string.
 */
export function createToolId(id: string): ToolId {
  return id as ToolId;
}

/**
 * Creates a JobId from a number.
 */
export function createJobId(n: number): JobId {
  return n as JobId;
}

/**
 * Creates a CaseId from a string.
 */
export function createCaseId(id: string): CaseId {
  return id as CaseId;
}

// ============================================================================
// Re-exported Location type for convenience
// ============================================================================

export type { Location };
