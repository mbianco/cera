/**
 * agent-interaction module (C7).
 *
 * The full LLM-facing surface: Session, Experiment, Workflow, and
 * Action. This is the final implementation phase (Phase 5),
 * depending on tool-invocation (Phase 4), data-management (Phase 3),
 * provenance (Phase 2), and scheduling (Phase 2).
 *
 * Public surface:
 * - Types: JobStatusReport, SessionServiceConfig, CreateExperimentInput,
 *   ExperimentFilter, CreateWorkflowInput, WorkflowStepInput,
 *   WorkflowServiceConfig, StepExecutionResult, ActionRequest,
 *   ActionResult, ActionServiceConfig, AgentInteractionConfig
 * - Defaults: DEFAULT_SESSION_SERVICE_CONFIG, DEFAULT_WORKFLOW_SERVICE_CONFIG,
 *   DEFAULT_ACTION_SERVICE_CONFIG, DEFAULT_AGENT_INTERACTION_CONFIG
 * - ID helpers: createSessionId, createUserId, createExperimentId,
 *   createWorkflowId, createWorkflowStepId, createActionId,
 *   createDatasetId, createToolId, createJobId, createCaseId
 * - Re-exported Location type (from ../types)
 * - ExperimentServiceImpl (and ExperimentServiceImplProps)
 * - SessionServiceImpl (and SessionServiceImplProps)
 * - WorkflowServiceImpl (and WorkflowServiceImplProps)
 * - WorkflowExecutor (and WorkflowExecutorProps, MissingInput)
 * - ActionServiceImpl (and ActionServiceImplProps)
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

// Types
//
// NOTE: `JobStatusReport` and `createCaseId` are intentionally
// NOT re-exported here. The scheduling module exports its own
// `JobStatusReport` and the tool-invocation module exports its own
// `createCaseId`; re-exporting both from the root barrel
// (`src/index.ts`) would create an ambiguous export. These symbols
// remain importable directly from `./types` (agent-interaction).
export type {
  SessionServiceConfig,
  CreateExperimentInput,
  ExperimentFilter,
  CreateWorkflowInput,
  WorkflowStepInput,
  WorkflowServiceConfig,
  StepExecutionResult,
  ActionRequest,
  ActionResult,
  ActionServiceConfig,
  AgentInteractionConfig,
  Location,
} from './types';

// Defaults and ID helpers
//
// `createCaseId` is omitted here (see note above); it is available
// from the tool-invocation module in the root barrel.
export {
  DEFAULT_SESSION_SERVICE_CONFIG,
  DEFAULT_WORKFLOW_SERVICE_CONFIG,
  DEFAULT_ACTION_SERVICE_CONFIG,
  DEFAULT_AGENT_INTERACTION_CONFIG,
  createSessionId,
  createUserId,
  createExperimentId,
  createWorkflowId,
  createWorkflowStepId,
  createActionId,
  createDatasetId,
  createToolId,
  createJobId,
} from './types';

// ExperimentService
export { ExperimentServiceImpl } from './experiment-service';
export type { ExperimentServiceImplProps } from './experiment-service';

// SessionService
export { SessionServiceImpl } from './session-service';
export type { SessionServiceImplProps } from './session-service';

// WorkflowService
export { WorkflowServiceImpl } from './workflow-service';
export type { WorkflowServiceImplProps } from './workflow-service';

// WorkflowExecutor
export { WorkflowExecutor } from './workflow-executor';
export type { WorkflowExecutorProps, MissingInput } from './workflow-executor';

// ActionService
export { ActionServiceImpl } from './action-service';
export type { ActionServiceImplProps } from './action-service';
