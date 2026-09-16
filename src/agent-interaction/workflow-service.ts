/**
 * WorkflowService implementation (C7).
 *
 * Manages Workflows — ordered sequences of ToolInvocations and/or
 * Case submissions with data dependencies (R6, ADR-006).
 *
 * Lifecycle:
 * - createWorkflow: creates a new Workflow belonging to an
 *   Experiment. Validates the Experiment exists synchronously
 *   (R2, ADR-002).
 * - addWorkflowStep: adds a WorkflowStep to a Workflow.
 * - startWorkflow: starts the Workflow. Each step's inputs are
 *   verified to exist and have Provenance before starting
 *   (INV-W1). Steps execute in order. If a step fails,
 *   downstream steps do NOT start automatically (INV-W2). The
 *   User is notified.
 * - resumeWorkflow: resumes a Workflow from its persisted state
 *   (R6). The Workflow may have been interrupted by Session end
 *   while waiting for a Job. On resume, the Agent queries the
 *   Scheduler for the Job's current state and continues
 *   accordingly.
 * - getWorkflowState: returns the current WorkflowState.
 * - getWorkflow: returns the full Workflow with all steps.
 *
 * Persistence (R6, ADR-006):
 * - Workflow state is persisted (in-memory for Phase 5;
 *   persistence to filesystem is the integrator's concern).
 * - A Workflow can be resumed across Sessions. If another
 *   Session is already running the same Workflow, the second
 *   resumeWorkflow is rejected (simple in-memory lock).
 *
 * Invariants enforced:
 * - INV-W1: A WorkflowStep may not begin until all its declared
 *   input Datasets exist and have Provenance.
 * - INV-W2: If a WorkflowStep fails, dependent downstream steps
 *   do not start automatically. The User is notified.
 * - INV-W3: Workflow describes real dependencies (best-effort,
 *   MEDIUM severity — not enforced in this implementation).
 * - INV-W4: Session can outlive Jobs. endSession (in
 *   SessionService) does NOT cancel running Jobs.
 *
 * Spec: api-contracts.md §7 (WorkflowService); module-graph.md
 * §7; invariants.md INV-W1–W4; resolutions.md R2, R6, R7;
 * ADR-002, ADR-006, ADR-007.
 */

import type { SchedulingService } from '../scheduling/types';
import type { DataManagementService } from '../data-management/types';
import type { ProvenanceService } from '../provenance/types';
import type { FilesystemGateway } from '../dsh-adapter/types';
import type { ToolInvocationService, ToolCatalogService, CaseService } from '../tool-invocation/types';
import type {
  DatasetId,
  JobId,
  Workflow,
  WorkflowEvent,
  WorkflowId,
  WorkflowState,
  WorkflowStep,
  WorkflowStepId,
} from '../types';
import { ExperimentNotFound } from '../types/errors';
import type {
  CreateWorkflowInput,
  WorkflowServiceConfig,
  WorkflowStepInput,
} from './types';
import { DEFAULT_WORKFLOW_SERVICE_CONFIG, createWorkflowId, createWorkflowStepId } from './types';
import { WorkflowExecutor } from './workflow-executor';
import type { WorkflowExecutorProps } from './workflow-executor';
import { WorkflowStore } from './workflow-store';

// ============================================================================
// WorkflowServiceImplProps
// ============================================================================

/**
 * Constructor parameters for WorkflowServiceImpl.
 *
 * `experimentService` — used for synchronous Experiment
 *   validation in `createWorkflow()`. If not provided, all
 *   Experiment IDs are accepted (for testing without a full
 *   Experiment store).
 *
 * `onEvent` — callback invoked when WorkflowEvents are produced.
 */
export interface WorkflowServiceImplProps {
  readonly dataManagement: DataManagementService;
  readonly provenance: ProvenanceService;
  readonly toolInvocation: ToolInvocationService;
  readonly caseService: CaseService;
  readonly catalog: ToolCatalogService;
  readonly scheduling: SchedulingService;
  readonly experimentService?: import('./experiment-service').ExperimentServiceImpl;
  /**
   * Filesystem gateway for Workflow persistence (ADR-006).
   * If omitted, persistence is disabled (in-memory only).
   */
  readonly filesystem?: FilesystemGateway;
  readonly config?: Partial<WorkflowServiceConfig>;
  readonly onEvent?: (event: WorkflowEvent) => void;
}

// ============================================================================
// Internal workflow tracking
// ============================================================================

/**
 * Internal mutable record tracking a Workflow's steps and state.
 */
interface InternalWorkflowRecord {
  workflow: Workflow;
  steps: Map<string, WorkflowStep>;
  locked: boolean;
}

// ============================================================================
// WorkflowServiceImpl
// ============================================================================

/**
 * WorkflowService implementation.
 *
 * R6: Workflow is first-class with persisted state. A User can
 * resume a Workflow across Sessions.
 *
 * ADR-006: If another Session is already running the same
 * Workflow, the second resumeWorkflow is rejected (simple
 * in-memory lock).
 *
 * INV-W1: Step inputs exist before step starts.
 * INV-W2: Failure halts downstream.
 * INV-W4: Session can outlive its Jobs' completion.
 *
 * Spec: api-contracts.md §7; invariants.md INV-W1–W4;
 * resolutions.md R2, R6, R7; ADR-002, ADR-006, ADR-007.
 */
export class WorkflowServiceImpl {
  #dataManagement: DataManagementService;
  #provenance: ProvenanceService;
  #toolInvocation: ToolInvocationService;
  #caseService: CaseService;
  #catalog: ToolCatalogService;
  #scheduling: SchedulingService;
  #experimentService?: import('./experiment-service').ExperimentServiceImpl;
  #config: WorkflowServiceConfig;
  #onEvent?: (event: WorkflowEvent) => void;
  #workflows: Map<string, InternalWorkflowRecord> = new Map();
  #executor: WorkflowExecutor;
  #store: WorkflowStore | null = null;

  constructor(props: WorkflowServiceImplProps) {
    this.#dataManagement = props.dataManagement;
    this.#provenance = props.provenance;
    this.#toolInvocation = props.toolInvocation;
    this.#caseService = props.caseService;
    this.#catalog = props.catalog;
    this.#scheduling = props.scheduling;
    this.#experimentService = props.experimentService;
    this.#config = {
      ...DEFAULT_WORKFLOW_SERVICE_CONFIG,
      ...props.config,
    };
    this.#onEvent = props.onEvent;

    // ADR-006: Filesystem-backed Workflow store. If filesystem is
    // not provided, persistence is disabled (in-memory only).
    if (props.filesystem !== undefined && this.#config.storePath.length > 0) {
      this.#store = new WorkflowStore({
        filesystem: props.filesystem,
        storePath: this.#config.storePath,
      });
    }

    const executorProps: WorkflowExecutorProps = {
      dataManagement: this.#dataManagement,
      provenance: this.#provenance,
      toolInvocation: this.#toolInvocation,
      caseService: this.#caseService,
      catalog: this.#catalog,
      scheduling: this.#scheduling,
      config: this.#config,
    };
    this.#executor = new WorkflowExecutor(executorProps);
  }

  // ========================================================================
  // createWorkflow (R2, ADR-006)
  // ========================================================================

  /**
   * Creates a new Workflow belonging to an Experiment (R2). The
   * Workflow has persisted state (R6, ADR-006) and survives
   * Session end.
   *
   * @throws {ExperimentNotFound} if the Experiment does not exist.
   *   Validation is synchronous because WorkflowService has access
   *   to ExperimentService (ADR-002).
   *
   * Spec: api-contracts.md §7 (createWorkflow); resolutions.md R2;
   * ADR-002, ADR-006.
   */
  async createWorkflow(input: CreateWorkflowInput): Promise<Workflow> {
    // R2, ADR-002: Synchronous validation that the Experiment
    // exists. WorkflowService has access to ExperimentService.
    if (this.#experimentService !== undefined) {
      const experiment = await this.#experimentService.getExperiment(
        input.experimentId,
      );
      if (experiment === null) {
        throw new ExperimentNotFound({
          experimentId: input.experimentId as string,
          workflowId: input.name,
        });
      }
    }

    const id = createWorkflowId(
      `wf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );
    const now = new Date();

    const workflow: Workflow = Object.freeze({
      id,
      name: input.name,
      experimentId: input.experimentId,
      state: 'NOT_STARTED' as WorkflowState,
      steps: [],
      createdAt: now,
      updatedAt: now,
    });

    this.#workflows.set(id as string, {
      workflow,
      steps: new Map<string, WorkflowStep>(),
      locked: false,
    });

    this.#emitEvent({
      kind: 'workflow_created',
      workflowId: id,
      experimentId: input.experimentId,
      name: input.name,
      timestamp: new Date(),
    });

    return workflow;
  }

  // ========================================================================
  // addWorkflowStep
  // ========================================================================

  /**
   * Adds a WorkflowStep to a Workflow.
   *
   * @throws {Error} if the Workflow does not exist.
   *
   * Spec: api-contracts.md §7 (addWorkflowStep).
   */
  async addWorkflowStep(
    workflowId: WorkflowId,
    step: WorkflowStepInput,
  ): Promise<void> {
    const record = this.#workflows.get(workflowId as string);
    if (record === undefined) {
      throw new Error(`Workflow '${workflowId as string}' not found.`);
    }

    const stepId = createWorkflowStepId(
      `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    );

    const workflowStep: WorkflowStep = Object.freeze({
      id: stepId,
      order: step.order,
      name: step.name,
      toolId: step.toolId,
      parameters: step.parameters,
      inputDatasetIds: step.inputDatasetIds,
      outputDatasetId: step.outputDatasetId,
      executionModel: step.executionModel ?? 'synchronous',
      resourceRequest: step.resourceRequest,
      state: 'NOT_STARTED',
    });

    record.steps.set(stepId as string, workflowStep);
    this.#updateWorkflowSteps(record);
  }

  // ========================================================================
  // startWorkflow (INV-W1, INV-W2)
  // ========================================================================

  /**
   * Starts the Workflow. Each step's inputs are verified to exist
   * and have Provenance before starting (INV-W1). Steps execute
   * in order. If a step fails, downstream steps do NOT start
   * automatically (INV-W2). The User is notified.
   *
   * If a step delegates to Scheduling (parallel execution), the
   * Workflow is set to IN_PROGRESS and waits for the Job.
   *
   * @throws {Error} if the Workflow does not exist.
   * @throws {Error} if the Workflow is not in NOT_STARTED state.
   *
   * Spec: api-contracts.md §7 (startWorkflow); invariants.md
   * INV-W1, INV-W2.
   */
  async startWorkflow(workflowId: WorkflowId): Promise<void> {
    const record = this.#workflows.get(workflowId as string);
    if (record === undefined) {
      throw new Error(`Workflow '${workflowId as string}' not found.`);
    }

    if (record.workflow.state !== 'NOT_STARTED') {
      throw new Error(
        `Workflow '${workflowId as string}' is in ${record.workflow.state} state, not NOT_STARTED. Use resumeWorkflow() to resume.`,
      );
    }

    // Lock the Workflow
    record.locked = true;

    await this.#executeSteps(record);
  }

  // ========================================================================
  // resumeWorkflow (R6, ADR-006)
  // ========================================================================

  /**
   * Resumes a Workflow from its persisted state (R6). The
   * Workflow may have been interrupted by Session end while
   * waiting for a Job. On resume, the Agent queries the
   * Scheduler for the Job's current state and continues
   * accordingly.
   *
   * ADR-006: If another Session is already running the same
   * Workflow, the second resumeWorkflow is rejected (simple
   * in-memory lock).
   *
   * @throws {Error} if the Workflow does not exist.
   * @throws {Error} if the Workflow is currently IN_PROGRESS
   *   (locked by another Session, ADR-006).
   * @throws {Error} if the Workflow is NOT_STARTED (use
   *   startWorkflow).
   * @throws {Error} if the Workflow is COMPLETE (already done).
   *
   * Spec: api-contracts.md §7 (resumeWorkflow); resolutions.md
   * R6, R7; ADR-006, ADR-007.
   */
  async resumeWorkflow(workflowId: WorkflowId): Promise<void> {
    const record = this.#workflows.get(workflowId as string);
    if (record === undefined) {
      throw new Error(`Workflow '${workflowId as string}' not found.`);
    }

    // ADR-006: If another Session is already running the same
    // Workflow, reject.
    if (record.locked) {
      throw new Error(
        `Workflow '${workflowId as string}' is currently running in another Session. Only one Session may run a Workflow at a time (ADR-006).`,
      );
    }

    if (record.workflow.state === 'NOT_STARTED') {
      throw new Error(
        `Workflow '${workflowId as string}' is in NOT_STARTED state. Use startWorkflow() to start it.`,
      );
    }

    if (record.workflow.state === 'COMPLETE') {
      throw new Error(
        `Workflow '${workflowId as string}' is already COMPLETE.`,
      );
    }

    // Lock the Workflow
    record.locked = true;

    // Emit WorkflowResumed event
    const fromState = record.workflow.state;
    this.#emitEvent({
      kind: 'workflow_resumed',
      workflowId,
      fromState,
      sessionId: '' as import('../types').SessionId, // Session ID is not tracked here
      timestamp: new Date(),
    });

    // Set state to IN_PROGRESS
    this.#setWorkflowState(record, 'IN_PROGRESS');

    // Re-execute from the first non-COMPLETED step
    await this.#executeSteps(record);
  }

  // ========================================================================
  // getWorkflowState
  // ========================================================================

  /**
   * Returns the current WorkflowState.
   *
   * @throws {Error} if the Workflow does not exist.
   *
   * Spec: api-contracts.md §7 (getWorkflowState).
   */
  async getWorkflowState(workflowId: WorkflowId): Promise<WorkflowState> {
    const record = this.#workflows.get(workflowId as string);
    if (record === undefined) {
      throw new Error(`Workflow '${workflowId as string}' not found.`);
    }
    return record.workflow.state;
  }

  // ========================================================================
  // getWorkflow
  // ========================================================================

  /**
   * Returns the full Workflow with all steps. Returns null if
   * the Workflow does not exist.
   *
   * Spec: api-contracts.md §7 (getWorkflow).
   */
  async getWorkflow(workflowId: WorkflowId): Promise<Workflow | null> {
    const record = this.#workflows.get(workflowId as string);
    if (record === undefined) {
      return null;
    }
    return record.workflow;
  }

  // ========================================================================
  // Test helpers (exposed for testing the in-memory lock)
  // ========================================================================

  /**
   * Locks a Workflow for testing purposes. This simulates
   * another Session currently running the Workflow.
   *
   * @internal
   */
  lockWorkflowForTesting(workflowId: WorkflowId): void {
    const record = this.#workflows.get(workflowId as string);
    if (record !== undefined) {
      record.locked = true;
    }
  }

  /**
   * Unlocks a Workflow for testing purposes.
   *
   * @internal
   */
  unlockWorkflowForTesting(workflowId: WorkflowId): void {
    const record = this.#workflows.get(workflowId as string);
    if (record !== undefined) {
      record.locked = false;
    }
  }

  // ========================================================================
  // Private: executeSteps (INV-W1, INV-W2)
  // ========================================================================

  /**
   * Executes the Workflow's steps sequentially, starting from
   * the first non-COMPLETED step.
   *
   * For each step:
   * 1. If the step is COMPLETED, skip (already done).
   * 2. Execute the step via WorkflowExecutor.executeStep().
   * 3. If blocked: set the Workflow to BLOCKED, stop, unlock.
   * 4. If failed: set the Workflow to FAILED, stop, unlock.
   *    Emit WorkflowStepFailed (INV-W2).
   * 5. If waiting (CESM Job): set the step to RUNNING with
   *    jobId, set the Workflow to IN_PROGRESS, keep locked
   *    (the Session is still active).
   * 6. If completed: set the step to COMPLETED, emit
   *    WorkflowStepStarted + WorkflowStepCompleted, continue.
   *
   * If all steps are COMPLETED, set the Workflow to COMPLETE and
   * unlock.
   *
   * INV-W1: Step inputs are verified by the executor before
   *   execution.
   * INV-W2: If a step fails, downstream steps are not started.
   */
  async #executeSteps(record: InternalWorkflowRecord): Promise<void> {
    const sortedSteps = Array.from(record.steps.values()).sort(
      (a, b) => a.order - b.order,
    );

    for (const step of sortedSteps) {
      // Skip completed steps
      if (step.state === 'COMPLETED') {
        continue;
      }

      // Emit WorkflowStepStarted
      this.#emitEvent({
        kind: 'workflow_step_started',
        workflowId: record.workflow.id,
        stepId: step.id,
        order: step.order,
        toolId: step.toolId,
        timestamp: new Date(),
      });

      // Set step to RUNNING
      this.#updateStep(record, step.id, { state: 'RUNNING' });

      // Execute the step. #updateStep above just set the step to
      // RUNNING, so it is guaranteed to exist in the record; the
      // guard is defensive only.
      const currentStep = this.#getStepFromRecord(record, step.id);
      if (currentStep === undefined) {
        continue;
      }
      const result = await this.#executor.executeStep(currentStep);

      if (result.kind === 'blocked') {
        // INV-W1: Step inputs do not exist or lack Provenance.
        // The Workflow is blocked.
        this.#updateStep(record, step.id, { state: 'BLOCKED' });
        this.#setWorkflowState(record, 'BLOCKED');
        record.locked = false;
        return;
      }

      if (result.kind === 'failed') {
        // INV-W2: Failure halts downstream.
        this.#updateStep(record, step.id, { state: 'FAILED' });
        this.#setWorkflowState(record, 'FAILED');
        record.locked = false;

        this.#emitEvent({
          kind: 'workflow_step_failed',
          workflowId: record.workflow.id,
          stepId: step.id,
          exitOutcome: { kind: 'exit_code', code: 1 },
          downstreamHalted: true,
          timestamp: new Date(),
        });
        return;
      }

      if (result.kind === 'waiting') {
        // The step submitted a Job and is waiting for it.
        // The Workflow remains IN_PROGRESS.
        this.#updateStep(record, step.id, {
          state: 'RUNNING',
          jobId: result.jobId,
        });
        this.#setWorkflowState(record, 'IN_PROGRESS');
        // Keep locked — the Session is still active
        return;
      }

      // result.kind === 'completed'
      this.#updateStep(record, step.id, {
        state: 'COMPLETED',
        toolInvocationId: result.toolInvocationId,
        outputDatasetId: result.outputDatasetId,
      });

      // The WorkflowStepCompleted event requires a non-optional
      // outputDatasetId. Both `result.outputDatasetId` (from the
      // executor) and `step.outputDatasetId` (declared at add time)
      // may be undefined in edge cases; emit the event only when a
      // concrete output Dataset is available.
      const completedOutputDatasetId =
        result.outputDatasetId ?? step.outputDatasetId;
      if (completedOutputDatasetId !== undefined) {
        this.#emitEvent({
          kind: 'workflow_step_completed',
          workflowId: record.workflow.id,
          stepId: step.id,
          outputDatasetId: completedOutputDatasetId,
          timestamp: new Date(),
        });
      }
    }

    // All steps completed
    this.#setWorkflowState(record, 'COMPLETE');
    record.locked = false;
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  /**
   * Gets a step from the record by ID.
   */
  #getStepFromRecord(
    record: InternalWorkflowRecord,
    stepId: WorkflowStepId,
  ): WorkflowStep | undefined {
    return record.steps.get(stepId as string);
  }

  /**
   * Updates a step in the record with new values.
   *
   * Since WorkflowStep is immutable, a new frozen object is
   * created.
   */
  #updateStep(
    record: InternalWorkflowRecord,
    stepId: WorkflowStepId,
    updates: {
      state?: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
      toolInvocationId?: string;
      outputDatasetId?: DatasetId;
      jobId?: JobId;
    },
  ): void {
    const existing = record.steps.get(stepId as string);
    if (existing === undefined) {
      return;
    }

    const updated: WorkflowStep = Object.freeze({
      ...existing,
      state: updates.state ?? existing.state,
      toolInvocationId:
        updates.toolInvocationId !== undefined
          ? (updates.toolInvocationId as import('../types').ToolInvocationId)
          : existing.toolInvocationId,
      outputDatasetId:
        updates.outputDatasetId !== undefined
          ? updates.outputDatasetId
          : existing.outputDatasetId,
      jobId: updates.jobId ?? existing.jobId,
    });

    record.steps.set(stepId as string, updated);
    this.#updateWorkflowSteps(record);
  }

  /**
   * Updates the stored Workflow's `steps` array from the
   * internal steps map.
   *
   * Since Workflow is immutable, a new frozen object is created.
   */
  #updateWorkflowSteps(record: InternalWorkflowRecord): void {
    const steps = Array.from(record.steps.values()).sort(
      (a, b) => a.order - b.order,
    );

    const updated: Workflow = Object.freeze({
      ...record.workflow,
      steps,
      updatedAt: new Date(),
    });

    record.workflow = updated;
  }

  /**
   * Sets the Workflow state and emits a WorkflowStateChanged
   * event. Also persists the Workflow to the filesystem store
   * (ADR-006).
   */
  #setWorkflowState(
    record: InternalWorkflowRecord,
    newState: WorkflowState,
  ): void {
    const previousState = record.workflow.state;
    if (previousState === newState) {
      return;
    }

    const updated: Workflow = Object.freeze({
      ...record.workflow,
      state: newState,
      updatedAt: new Date(),
    });

    record.workflow = updated;

    this.#emitEvent({
      kind: 'workflow_state_changed',
      workflowId: record.workflow.id,
      previousState,
      newState,
      timestamp: new Date(),
    });

    // ADR-006: Persist to filesystem (best-effort, non-blocking)
    void this.#persist(record);
  }

  /**
   * Emits a WorkflowEvent to the onEvent callback.
   */
  #emitEvent(event: WorkflowEvent): void {
    this.#onEvent?.(event);
  }

  /**
   * Persists a Workflow to the filesystem store (ADR-006).
   *
   * Best-effort: if the write fails, the error is logged but not
   * thrown. The in-memory state is authoritative during the
   * Session; the filesystem store is for cross-Session recovery.
   */
  async #persist(record: InternalWorkflowRecord): Promise<void> {
    if (this.#store === null) return;
    try {
      await this.#store.save(
        record.workflow,
        Array.from(record.steps.values()),
      );
    } catch {
      // Best-effort persistence — log but don't throw.
      // The in-memory state is authoritative during the Session.
    }
  }
}
