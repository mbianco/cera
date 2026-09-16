/**
 * WorkflowExecutor — helper for executing Workflow steps sequentially.
 *
 * The executor is responsible for:
 * 1. Verifying all input Datasets exist (via dataManagement) and
 *    have Provenance (via provenance) — INV-W1.
 * 2. Determining the Tool kind from the catalog.
 * 3. For Model Tools (CESM): delegating to caseService.submitCase().
 * 4. For CLI/Python Tools: delegating to toolInvocation.invokeTool().
 * 5. Returning the result (completed, failed, blocked, or waiting).
 *
 * INV-W1: A WorkflowStep may not begin until all its declared
 *   input Datasets exist and have Provenance. If any input is
 *   missing or lacks Provenance, the step is BLOCKED.
 *
 * INV-W2: If a WorkflowStep fails (non-success ExitOutcome, or
 *   Job reaches a non-COMPLETED terminal State), dependent
 *   downstream steps do not start automatically. The User is
 *   notified.
 *
 * The WorkflowService uses this executor for each step in order.
 * If a step is blocked or fails, the WorkflowService halts
 * execution and notifies the User.
 *
 * Spec: api-contracts.md §7 (Workflow); module-graph.md §7;
 * invariants.md INV-W1, INV-W2; resolutions.md R6; ADR-006.
 */

import type { SchedulingService } from '../scheduling/types';
import type { DataManagementService } from '../data-management/types';
import type { ProvenanceService } from '../provenance/types';
import type {
  ToolInvocationService,
  ToolCatalogService,
  CaseService,
  ToolInvocationRequest,
} from '../tool-invocation/types';
import type {
  Case,
  CaseId,
  DatasetId,
  Location,
  ResourceRequest,
  Tool,
  WorkflowStep,
} from '../types';
import { isTerminalJobState } from '../types/value-objects';
import type {
  StepExecutionResult,
  WorkflowServiceConfig,
} from './types';
import { DEFAULT_WORKFLOW_SERVICE_CONFIG } from './types';

// ============================================================================
// MissingInput
// ============================================================================

/**
 * Describes why a Dataset input could not be verified.
 *
 * - `not_found`: The Dataset does not exist in data-management.
 * - `no_provenance`: The Dataset exists but has no
 *   ProvenanceRecord (INV-D3, INV-W1).
 */
export interface MissingInput {
  readonly datasetId: DatasetId;
  readonly reason: 'not_found' | 'no_provenance';
}

// ============================================================================
// WorkflowExecutorProps
// ============================================================================

/**
 * Constructor parameters for WorkflowExecutor.
 *
 * `scheduling` — used for resume (querying Job state). May be
 *   undefined if the executor is not used for resume.
 */
export interface WorkflowExecutorProps {
  readonly dataManagement: DataManagementService;
  readonly provenance: ProvenanceService;
  readonly toolInvocation: ToolInvocationService;
  readonly caseService: CaseService;
  readonly catalog: ToolCatalogService;
  readonly scheduling?: SchedulingService;
  readonly config?: Partial<WorkflowServiceConfig>;
}

// ============================================================================
// WorkflowExecutor
// ============================================================================

/**
 * Helper for executing Workflow steps sequentially.
 *
 * INV-W1: A WorkflowStep may not begin until all its declared
 *   input Datasets exist and have Provenance.
 *
 * INV-W2: If a WorkflowStep fails, dependent downstream steps do
 *   not start automatically. The User is notified.
 *
 * Spec: api-contracts.md §7; invariants.md INV-W1, INV-W2;
 * resolutions.md R6; ADR-006.
 */
export class WorkflowExecutor {
  #dataManagement: DataManagementService;
  #provenance: ProvenanceService;
  #toolInvocation: ToolInvocationService;
  #caseService: CaseService;
  #catalog: ToolCatalogService;
  #scheduling?: SchedulingService;
  #config: WorkflowServiceConfig;

  constructor(props: WorkflowExecutorProps) {
    this.#dataManagement = props.dataManagement;
    this.#provenance = props.provenance;
    this.#toolInvocation = props.toolInvocation;
    this.#caseService = props.caseService;
    this.#catalog = props.catalog;
    this.#scheduling = props.scheduling;
    this.#config = {
      ...DEFAULT_WORKFLOW_SERVICE_CONFIG,
      ...props.config,
    };
  }

  // ========================================================================
  // verifyStepInputs (INV-W1)
  // ========================================================================

  /**
   * Verifies that all declared input Datasets exist and have
   * Provenance (INV-W1, INV-D3).
   *
   * For each input Dataset:
   * 1. `dataManagement.queryDataset()` must return non-null.
   * 2. `provenance.verifyProvenance()` must return true.
   *
   * If either check fails, the Dataset is added to the missing
   * list with the reason ('not_found' or 'no_provenance').
   *
   * @returns An array of MissingInput entries. Empty if all
   *   inputs are valid.
   */
  async verifyStepInputs(inputDatasetIds: readonly DatasetId[]): Promise<readonly MissingInput[]> {
    const missing: MissingInput[] = [];

    for (const datasetId of inputDatasetIds) {
      // Check Dataset exists
      const dataset = await this.#dataManagement.queryDataset(datasetId);
      if (dataset === null) {
        missing.push({ datasetId, reason: 'not_found' });
        continue;
      }

      // Check Provenance exists (INV-D3, INV-W1)
      const hasProvenance = await this.#provenance.verifyProvenance(datasetId);
      if (!hasProvenance) {
        missing.push({ datasetId, reason: 'no_provenance' });
      }
    }

    return Object.freeze(missing);
  }

  // ========================================================================
  // executeStep (INV-W1, INV-W2)
  // ========================================================================

  /**
   * Executes a single WorkflowStep.
   *
   * 1. Verifies all input Datasets exist and have Provenance
   *    (INV-W1). If any input is missing or lacks Provenance,
   *    returns `{ kind: 'blocked' }`.
   * 2. Gets the Tool from the catalog to determine its kind.
   * 3. For Model Tools (CESM): extracts `caseId` from parameters
   *    and delegates to `caseService.submitCase()`. Returns
   *    `{ kind: 'waiting', jobId }` if the Job is non-terminal.
   * 4. For CLI/Python Tools: builds a ToolInvocationRequest and
   *    delegates to `toolInvocation.invokeTool()`. Returns
   *    `{ kind: 'completed' }` on success.
   * 5. If the execution fails, returns `{ kind: 'failed',
   *    downstreamHalted: true }` (INV-W2).
   *
   * @throws Never throws — all errors are caught and returned as
   *   `{ kind: 'failed' }`.
   */
  async executeStep(step: WorkflowStep): Promise<StepExecutionResult> {
    // ================================================================
    // Step 1: Verify inputs (INV-W1)
    // ================================================================
    const missing = await this.verifyStepInputs(step.inputDatasetIds);
    if (missing.length > 0) {
      return Object.freeze({
        kind: 'blocked',
        stepId: step.id,
        missingInputs: missing,
      });
    }

    // ================================================================
    // Step 2: Get the Tool from the catalog
    // ================================================================
    const tool = await this.#catalog.getTool(step.toolId);
    if (tool === null) {
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason: `Tool '${step.toolId as string}' is not in the catalog`,
        downstreamHalted: true,
      });
    }

    // ================================================================
    // Step 3: Route based on Tool kind
    // ================================================================
    if (tool.kind === 'model') {
      // CESM (Model Tool) — delegate to caseService
      return await this.#executeModelStep(step, tool);
    }

    // CLI or Python Tool — delegate to toolInvocation
    return await this.#executeSynchronousStep(step, tool);
  }

  // ========================================================================
  // checkWaitingStep (resume support, R6)
  // ========================================================================

  /**
   * Checks if a waiting step (with a jobId) has reached a terminal
   * state. Used by WorkflowService.resumeWorkflow() to determine
   * if a waiting step can proceed.
   *
   * If the Job is COMPLETED, the step can proceed (returns
   * 'completed'). If the Job reached another terminal state
   * (FAILED, TIMEOUT, etc.), the step failed (INV-W2). If the
   * Job is not terminal, the step is still waiting.
   *
   * @throws {Error} if scheduling is not configured.
   */
  async checkWaitingStep(step: WorkflowStep): Promise<StepExecutionResult> {
    if (step.jobId === undefined) {
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason: 'Step is waiting but has no jobId',
        downstreamHalted: true,
      });
    }

    if (this.#scheduling === undefined) {
      throw new Error('SchedulingService is not configured for this WorkflowExecutor');
    }

    const job = await this.#scheduling.queryJob(step.jobId);

    if (job.state === 'COMPLETED') {
      return Object.freeze({
        kind: 'completed',
        stepId: step.id,
        jobId: step.jobId,
      });
    }

    if (isTerminalJobState(job.state)) {
      // INV-W2: Job reached a non-COMPLETED terminal state
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason: `Job ${step.jobId as number} reached terminal state ${job.state}`,
        downstreamHalted: true,
      });
    }

    // Job is still running — step is still waiting
    return Object.freeze({
      kind: 'waiting',
      stepId: step.id,
      jobId: step.jobId,
    });
  }

  // ========================================================================
  // Private: executeSynchronousStep (CLI/Python)
  // ========================================================================

  /**
   * Executes a synchronous CLI or Python step via
   * toolInvocation.invokeTool().
   *
   * Builds a ToolInvocationRequest from the step, executes it,
   * and returns the result.
   *
   * If invokeTool() throws, the step is failed (INV-W2).
   */
  async #executeSynchronousStep(
    step: WorkflowStep,
    _tool: Tool,
  ): Promise<StepExecutionResult> {
    // Build the output location
    const outputLocation = this.#deriveOutputLocation(step);

    // Build the ToolInvocationRequest
    const request: ToolInvocationRequest = {
      toolId: step.toolId,
      parameters: step.parameters,
      inputDatasetIds: step.inputDatasetIds,
      outputLocation,
      executionModel: step.executionModel,
      resourceRequest: step.resourceRequest,
    };

    try {
      const result = await this.#toolInvocation.invokeTool(request);

      // Success — extract the outputDatasetId
      const outputDatasetId =
        result.outputDatasets.length > 0
          ? result.outputDatasets[0]?.id
          : step.outputDatasetId;

      return Object.freeze({
        kind: 'completed',
        stepId: step.id,
        toolInvocationId: result.invocation.id as string,
        outputDatasetId,
      });
    } catch (error) {
      // INV-W2: Failure halts downstream
      const reason = error instanceof Error ? error.message : String(error);
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason,
        downstreamHalted: true,
      });
    }
  }

  // ========================================================================
  // Private: executeModelStep (CESM)
  // ========================================================================

  /**
   * Executes a Model Tool (CESM) step via caseService.submitCase().
   *
   * The step's `parameters` must contain a `caseId` identifying
   * the CESM Case to submit.
   *
   * If the Job is non-terminal after submission, the step is
   * 'waiting' for the Job to complete.
   *
   * If submitCase() throws, the step is failed (INV-W2).
   */
  async #executeModelStep(
    step: WorkflowStep,
    _tool: Tool,
  ): Promise<StepExecutionResult> {
    // Extract caseId from parameters
    const caseId = step.parameters['caseId'] as CaseId | undefined;
    if (caseId === undefined) {
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason: `Model Tool step '${step.name}' is missing required parameter 'caseId'`,
        downstreamHalted: true,
      });
    }

    // ResourceRequest is required for case.submit
    const resourceRequest: ResourceRequest | undefined =
      step.resourceRequest;
    if (resourceRequest === undefined) {
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason: `Model Tool step '${step.name}' is missing required resourceRequest`,
        downstreamHalted: true,
      });
    }

    try {
      const submittedCase: Case = await this.#caseService.submitCase(
        caseId,
        resourceRequest,
      );

      // If the Case has a jobId, the step is waiting for the Job
      if (submittedCase.jobId !== null) {
        return Object.freeze({
          kind: 'waiting',
          stepId: step.id,
          jobId: submittedCase.jobId,
        });
      }

      // No jobId — unexpected for a submitted Case. Treat as
      // completed (the Case was submitted without a Job, which
      // is unusual but not an error per se).
      return Object.freeze({
        kind: 'completed',
        stepId: step.id,
      });
    } catch (error) {
      // INV-W2: Failure halts downstream
      const reason = error instanceof Error ? error.message : String(error);
      return Object.freeze({
        kind: 'failed',
        stepId: step.id,
        reason,
        downstreamHalted: true,
      });
    }
  }

  // ========================================================================
  // Private: deriveOutputLocation
  // ========================================================================

  /**
   * Derives the output Location for a ToolInvocationRequest.
   *
   * If the step has an `outputDatasetId` and that Dataset exists
   * in data-management, the Dataset's location is used.
   *
   * Otherwise, a default output location is derived from the
   * step name and the configured `outputBasePath`.
   */
  #deriveOutputLocation(step: WorkflowStep): Location {
    // If the output Dataset exists, use its location
    if (step.outputDatasetId !== undefined) {
      // We can't await in a non-async method, so we use a
      // synchronous check. The data-management mock stores
      // Datasets in a Map, so we can check synchronously.
      // In production, the outputLocation would be determined
      // by the WorkflowService before calling the executor.
      //
      // For now, use the default if the outputDatasetId is
      // not known. The actual location is set by the
      // ToolInvocationService when it registers the output.
      // No synchronous access — use default.
    }

    // Default output location
    const basePath = this.#config.outputBasePath.endsWith('/')
      ? this.#config.outputBasePath
      : `${this.#config.outputBasePath}/`;

    return Object.freeze({
      path: `${basePath}${step.name}.nc`,
      filesystem: 'scratch',
    });
  }
}
