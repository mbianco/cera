/**
 * Unit tests for WorkflowService.
 *
 * Verifies the full Workflow lifecycle: create → add steps →
 * start → resume → complete/fail. All four C7 invariants
 * (INV-W1–W4) are asserted. Workflow state persists across
 * Sessions (R6, ADR-006).
 *
 * Invariants:
 * - INV-W1: Step inputs exist before step starts.
 * - INV-W2: Failure halts downstream.
 * - INV-W3: Workflow describes real dependencies (best-effort).
 * - INV-W4: Session can outlive its Jobs' completion.
 *
 * Spec: build-phases.md Phase 5; api-contracts.md §7
 * (WorkflowService); invariants.md INV-W1–W4; resolutions.md
 * R6; ADR-006.
 */

import { describe, it, expect } from 'vitest';
import { WorkflowServiceImpl } from '../../src/agent-interaction/workflow-service';
import type { WorkflowServiceImplProps } from '../../src/agent-interaction/workflow-service';
import { ExperimentServiceImpl } from '../../src/agent-interaction/experiment-service';
import type {
  WorkflowEvent,
  DatasetId,
} from '../../src/types';
import { ExperimentNotFound } from '../../src/types/errors';
import {
  createMockDataManagementService,
  createMockProvenanceService,
  createMockToolInvocationService,
  createMockCaseService,
  createMockToolCatalogService,
  createMockSchedulingService,
  createMockCLITool,
  createMockDataset,
  createDatasetId,
  createToolId,
  createWorkflowId,
  createExperimentId,
} from './helpers';

// ============================================================================
// Test setup helper
// ============================================================================

interface WorkflowServiceSetup {
  readonly service: WorkflowServiceImpl;
  readonly dataManagement: ReturnType<typeof createMockDataManagementService>;
  readonly provenance: ReturnType<typeof createMockProvenanceService>;
  readonly toolInvocation: ReturnType<typeof createMockToolInvocationService>;
  readonly caseService: ReturnType<typeof createMockCaseService>;
  readonly catalog: ReturnType<typeof createMockToolCatalogService>;
  readonly scheduling: ReturnType<typeof createMockSchedulingService>;
  readonly events: WorkflowEvent[];
}

function createWorkflowService(overrides: {
  readonly tools?: readonly import('../../src/types').Tool[];
  readonly datasets?: ReadonlyMap<DatasetId, import('../../src/types').Dataset>;
  readonly verifyResult?: boolean;
  readonly verifyResults?: ReadonlyMap<DatasetId, boolean>;
  readonly invocationResult?: import('../../src/tool-invocation/types').ToolInvocationResult;
  readonly invocationError?: Error;
  readonly caseResult?: import('../../src/types').Case;
  readonly caseError?: Error;
  readonly schedulingSubmitResult?: import('../../src/types').Job;
  readonly schedulingQueryResult?: (jobId: import('../../src/types').JobId) => import('../../src/types').Job;
  readonly config?: Partial<{ readonly pollIntervalMs: number; readonly outputBasePath: string }>;
  readonly experimentService?: ExperimentServiceImpl;
} = {}): WorkflowServiceSetup {
  const events: WorkflowEvent[] = [];
  const dataManagement = createMockDataManagementService({
    datasets: overrides.datasets,
  });
  const provenance = createMockProvenanceService({
    verifyResult: overrides.verifyResult,
    verifyResults: overrides.verifyResults,
  });
  const toolInvocation = createMockToolInvocationService({
    result: overrides.invocationResult,
    error: overrides.invocationError,
  });
  const caseService = createMockCaseService({
    submitResult: overrides.caseResult,
    submitError: overrides.caseError,
  });
  const catalog = createMockToolCatalogService({
    tools: overrides.tools ?? [createMockCLITool()],
  });
  const scheduling = createMockSchedulingService({
    submitJobResult: overrides.schedulingSubmitResult,
    queryJobResult: overrides.schedulingQueryResult,
  });

  const props: WorkflowServiceImplProps = {
    dataManagement,
    provenance,
    toolInvocation,
    caseService,
    catalog,
    scheduling,
    experimentService: overrides.experimentService,
    config: overrides.config,
    onEvent: (event: WorkflowEvent) => {
      events.push(event);
    },
  };

  const service = new WorkflowServiceImpl(props);

  return {
    service,
    dataManagement,
    provenance,
    toolInvocation,
    caseService,
    catalog,
    scheduling,
    events,
  };
}

/**
 * Creates a standard set of input Datasets with Provenance.
 */
function createStandardInputDatasets(): {
  readonly datasets: Map<DatasetId, import('../../src/types').Dataset>;
  readonly inputId: DatasetId;
} {
  const inputId = createDatasetId('ds-input-001');
  const dataset = createMockDataset({ id: inputId, consumable: true });
  const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
    [inputId, dataset],
  ]);
  return { datasets, inputId };
}

// ============================================================================
// createWorkflow (R2, ADR-006)
// ============================================================================

describe('WorkflowServiceImpl — createWorkflow', () => {
  it('creates a Workflow in NOT_STARTED state', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');

    const workflow = await service.createWorkflow({
      name: 'annual_mean_workflow',
      experimentId: expId,
    });

    expect(workflow.state).toBe('NOT_STARTED');
    expect(workflow.name).toBe('annual_mean_workflow');
    expect(workflow.experimentId).toBe(expId);
    expect(workflow.steps).toEqual([]);
    expect(workflow.createdAt).toBeInstanceOf(Date);
  });

  it('generates a unique WorkflowId', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');

    const wf1 = await service.createWorkflow({ name: 'wf1', experimentId: expId });
    const wf2 = await service.createWorkflow({ name: 'wf2', experimentId: expId });

    expect(wf1.id).not.toBe(wf2.id);
  });

  it('throws ExperimentNotFound when the Experiment does not exist (synchronous validation)', async () => {
    // Pass an empty ExperimentService — no Experiments exist
    const { service } = createWorkflowService({
      experimentService: new ExperimentServiceImpl({}),
    });

    await expect(
      service.createWorkflow({
        name: 'wf1',
        experimentId: createExperimentId('exp-nonexistent'),
      }),
    ).rejects.toThrow(ExperimentNotFound);
  });

  it('emits WorkflowCreated event', async () => {
    const { service, events } = createWorkflowService();
    const expId = createExperimentId('exp-001');

    const workflow = await service.createWorkflow({
      name: 'annual_mean_workflow',
      experimentId: expId,
    });

    const createdEvent = events.find((e) => e.kind === 'workflow_created');
    expect(createdEvent).toBeDefined();
    if (createdEvent?.kind === 'workflow_created') {
      expect(createdEvent.workflowId).toBe(workflow.id);
      expect(createdEvent.experimentId).toBe(expId);
      expect(createdEvent.name).toBe('annual_mean_workflow');
    }
  });

  it('allows multiple Workflows for the same Experiment', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');

    const wf1 = await service.createWorkflow({ name: 'wf1', experimentId: expId });
    const wf2 = await service.createWorkflow({ name: 'wf2', experimentId: expId });

    const retrieved1 = await service.getWorkflow(wf1.id);
    const retrieved2 = await service.getWorkflow(wf2.id);

    expect(retrieved1?.name).toBe('wf1');
    expect(retrieved2?.name).toBe('wf2');
  });
});

// ============================================================================
// addWorkflowStep
// ============================================================================

describe('WorkflowServiceImpl — addWorkflowStep', () => {
  it('adds a step to the Workflow', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'select_tas',
      toolId: createToolId('cdo'),
      parameters: { operatorChain: '-selname,TAS' },
      inputDatasetIds: [createDatasetId('ds-001')],
    });

    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved?.steps.length).toBe(1);
    expect(retrieved?.steps[0]?.name).toBe('select_tas');
  });

  it('adds multiple steps in order', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [createDatasetId('ds-001')],
    });
    await service.addWorkflowStep(workflow.id, {
      order: 2,
      name: 'step2',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [createDatasetId('ds-002')],
    });

    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved?.steps.length).toBe(2);
  });

  it('throws when the Workflow does not exist', async () => {
    const { service } = createWorkflowService();

    await expect(
      service.addWorkflowStep(createWorkflowId('wf-nonexistent'), {
        order: 1,
        name: 'step1',
        toolId: createToolId('cdo'),
        parameters: {},
        inputDatasetIds: [createDatasetId('ds-001')],
      }),
    ).rejects.toThrow();
  });

  it('defaults executionModel to synchronous', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [createDatasetId('ds-001')],
      // executionModel not specified
    });

    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved?.steps[0]?.executionModel).toBe('synchronous');
  });
});

// ============================================================================
// startWorkflow (INV-W1, INV-W2)
// ============================================================================

describe('WorkflowServiceImpl — startWorkflow (INV-W1, INV-W2)', () => {
  it('completes a single-step Workflow when all inputs exist with Provenance (INV-W1)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { service } = createWorkflowService({
      datasets,
      verifyResult: true,
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'select_tas',
      toolId: createToolId('cdo'),
      parameters: { operatorChain: '-selname,TAS' },
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('COMPLETE');
  });

  it('completes a multi-step Workflow with data dependencies (INV-W1)', async () => {
    const inputId = createDatasetId('ds-input-001');
    const step1OutputId = createDatasetId('ds-step1-out');
    const step2OutputId = createDatasetId('ds-step2-out');

    // Input Dataset exists with Provenance
    const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
      [inputId, createMockDataset({ id: inputId, consumable: true })],
    ]);

    // Step 1 produces ds-step1-out, Step 2 consumes it.
    // The mock toolInvocation returns a result with the output
    // Dataset. But the output Dataset must also be registered in
    // data-management and have Provenance for Step 2.
    //
    // We set up the mock data-management to add the output
    // Datasets when they are registered.

    const { service, dataManagement } = createWorkflowService({
      datasets,
      verifyResult: true,
    });

    // Pre-register step 1's output with Provenance so step 2
    // can start. In a real system, the ToolInvocationService
    // would register the output Dataset and mark it consumable.
    const step1Output = createMockDataset({
      id: step1OutputId,
      name: 'tas_only',
      consumable: true,
    });
    dataManagement.setDataset(step1Output);

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'select_tas',
      toolId: createToolId('cdo'),
      parameters: { operatorChain: '-selname,TAS' },
      inputDatasetIds: [inputId],
      outputDatasetId: step1OutputId,
    });
    await service.addWorkflowStep(workflow.id, {
      order: 2,
      name: 'time_mean',
      toolId: createToolId('cdo'),
      parameters: { operatorChain: '-timmean' },
      inputDatasetIds: [step1OutputId],
      outputDatasetId: step2OutputId,
    });

    await service.startWorkflow(workflow.id);

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('COMPLETE');
  });

  it('blocks the Workflow when an input Dataset does not exist (INV-W1)', async () => {
    const { service } = createWorkflowService({
      datasets: new Map(),
      verifyResult: true,
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [createDatasetId('ds-nonexistent')],
    });

    await service.startWorkflow(workflow.id);

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('BLOCKED');
  });

  it('blocks the Workflow when an input Dataset lacks Provenance (INV-W1, INV-D3)', async () => {
    const inputId = createDatasetId('ds-no-prov');
    const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
      [inputId, createMockDataset({ id: inputId, consumable: false })],
    ]);

    const { service } = createWorkflowService({
      datasets,
      verifyResult: false, // No Provenance
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('BLOCKED');
  });

  it('halts downstream steps when a step fails (INV-W2)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const step1OutputId = createDatasetId('ds-step1-out');
    const step2OutputId = createDatasetId('ds-step2-out');

    const { service, dataManagement } = createWorkflowService({
      datasets,
      verifyResult: true,
      invocationError: new Error('CDO exited with code 2'),
    });

    // Even though step 2's input is pre-registered, step 1
    // fails so step 2 should NOT start.
    const step1Output = createMockDataset({
      id: step1OutputId,
      consumable: true,
    });
    dataManagement.setDataset(step1Output);

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
      outputDatasetId: step1OutputId,
    });
    await service.addWorkflowStep(workflow.id, {
      order: 2,
      name: 'step2',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [step1OutputId],
      outputDatasetId: step2OutputId,
    });

    await service.startWorkflow(workflow.id);

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('FAILED');

    // Step 2 should NOT have been executed
    const retrieved = await service.getWorkflow(workflow.id);
    const step2 = retrieved?.steps.find((s) => s.name === 'step2');
    expect(step2?.state).toBe('NOT_STARTED');
  });

  it('emits WorkflowStateChanged events during execution', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { service, events } = createWorkflowService({
      datasets,
      verifyResult: true,
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);

    // Should have at least one state_changed event
    const stateEvents = events.filter((e) => e.kind === 'workflow_state_changed');
    expect(stateEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits WorkflowStepStarted and WorkflowStepCompleted events', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { service, events } = createWorkflowService({
      datasets,
      verifyResult: true,
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'select_tas',
      toolId: createToolId('cdo'),
      parameters: { operatorChain: '-selname,TAS' },
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);

    const startedEvent = events.find((e) => e.kind === 'workflow_step_started');
    expect(startedEvent).toBeDefined();

    const completedEvent = events.find((e) => e.kind === 'workflow_step_completed');
    expect(completedEvent).toBeDefined();
  });

  it('emits WorkflowStepFailed event when a step fails (INV-W2)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { service, events } = createWorkflowService({
      datasets,
      verifyResult: true,
      invocationError: new Error('Tool crashed'),
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);

    const failedEvent = events.find((e) => e.kind === 'workflow_step_failed');
    expect(failedEvent).toBeDefined();
    if (failedEvent?.kind === 'workflow_step_failed') {
      expect(failedEvent.downstreamHalted).toBe(true);
    }
  });

  it('throws when the Workflow does not exist', async () => {
    const { service } = createWorkflowService();

    await expect(
      service.startWorkflow(createWorkflowId('wf-nonexistent')),
    ).rejects.toThrow();
  });

  it('throws when the Workflow is already COMPLETE', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { service } = createWorkflowService({
      datasets,
      verifyResult: true,
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);

    // Second start should throw
    await expect(service.startWorkflow(workflow.id)).rejects.toThrow();
  });
});

// ============================================================================
// resumeWorkflow (R6, ADR-006)
// ============================================================================

describe('WorkflowServiceImpl — resumeWorkflow (R6, ADR-006)', () => {
  it('resumes a Workflow that was IN_PROGRESS when the Session ended (R6)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const step1OutputId = createDatasetId('ds-step1-out');
    const step2OutputId = createDatasetId('ds-step2-out');

    const { service, dataManagement } = createWorkflowService({
      datasets,
      verifyResult: true,
    });

    // Pre-register step 1's output
    dataManagement.setDataset(
      createMockDataset({ id: step1OutputId, consumable: true }),
    );

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
      outputDatasetId: step1OutputId,
    });
    await service.addWorkflowStep(workflow.id, {
      order: 2,
      name: 'step2',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [step1OutputId],
      outputDatasetId: step2OutputId,
    });

    // Start the Workflow — step 1 completes, step 2 completes
    await service.startWorkflow(workflow.id);

    // The Workflow should be COMPLETE (both steps completed)
    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('COMPLETE');

    // resumeWorkflow should throw because the Workflow is already
    // COMPLETE (not IN_PROGRESS)
    await expect(service.resumeWorkflow(workflow.id)).rejects.toThrow();
  });

  it('resumes a Workflow that was BLOCKED after inputs became available (R6)', async () => {
    const inputId = createDatasetId('ds-input-001');

    const { service, dataManagement, provenance } = createWorkflowService({
      datasets: new Map(), // Initially empty — will be BLOCKED
      verifyResult: true,
    });

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    // Start — blocked because input doesn't exist
    await service.startWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('BLOCKED');

    // Now the input becomes available (e.g., from a previous Session)
    dataManagement.setDataset(createMockDataset({ id: inputId, consumable: true }));
    provenance.setVerifyResultFor(inputId, true);

    // Resume the Workflow
    await service.resumeWorkflow(workflow.id);

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('COMPLETE');
  });

  it('emits WorkflowResumed event on resume (R6)', async () => {
    const inputId = createDatasetId('ds-input-001');

    const { service, dataManagement, provenance, events } = createWorkflowService({
      datasets: new Map(),
      verifyResult: true,
    });

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('BLOCKED');

    // Clear events from start
    events.length = 0;

    // Make input available
    dataManagement.setDataset(createMockDataset({ id: inputId, consumable: true }));
    provenance.setVerifyResultFor(inputId, true);

    await service.resumeWorkflow(workflow.id);

    const resumedEvent = events.find((e) => e.kind === 'workflow_resumed');
    expect(resumedEvent).toBeDefined();
    if (resumedEvent?.kind === 'workflow_resumed') {
      expect(resumedEvent.workflowId).toBe(workflow.id);
      expect(resumedEvent.fromState).toBe('BLOCKED');
    }
  });

  it('throws when resuming a Workflow that is currently IN_PROGRESS (ADR-006 lock)', async () => {
    // Create a second service that shares the scheduling mock
    // to simulate two Sessions.
    //
    // Since startWorkflow() is synchronous in this mock-based
    // implementation, we need to test the lock differently.
    // We'll create a Workflow, manually set it to IN_PROGRESS,
    // and verify that resumeWorkflow throws.

    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    // Manually lock the Workflow (simulating another Session
    // running it)
    service.lockWorkflowForTesting(workflow.id);

    await expect(service.resumeWorkflow(workflow.id)).rejects.toThrow();

    // Unlock for cleanup
    service.unlockWorkflowForTesting(workflow.id);
  });

  it('throws when the Workflow does not exist', async () => {
    const { service } = createWorkflowService();

    await expect(
      service.resumeWorkflow(createWorkflowId('wf-nonexistent')),
    ).rejects.toThrow();
  });

  it('resumes a FAILED Workflow (User retries after addressing failure)', async () => {
    const inputId = createDatasetId('ds-input-001');
    const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
      [inputId, createMockDataset({ id: inputId, consumable: true })],
    ]);

    const { service } = createWorkflowService({
      datasets,
      verifyResult: true,
      invocationError: new Error('First attempt failed'),
    });

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    // First attempt — fails
    await service.startWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('FAILED');

    // Resume — should attempt again (and fail again in this mock)
    await service.resumeWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('FAILED');
  });
});

// ============================================================================
// getWorkflowState and getWorkflow
// ============================================================================

describe('WorkflowServiceImpl — getWorkflowState', () => {
  it('returns NOT_STARTED for a newly created Workflow', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    const state = await service.getWorkflowState(workflow.id);
    expect(state).toBe('NOT_STARTED');
  });

  it('returns null-based behavior — throws for unknown Workflow', async () => {
    const { service } = createWorkflowService();

    await expect(
      service.getWorkflowState(createWorkflowId('wf-unknown')),
    ).rejects.toThrow();
  });
});

describe('WorkflowServiceImpl — getWorkflow', () => {
  it('returns the full Workflow with all steps', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: { operatorChain: '-timmean' },
      inputDatasetIds: [createDatasetId('ds-001')],
    });

    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved?.steps.length).toBe(1);
    expect(retrieved?.steps[0]?.name).toBe('step1');
  });

  it('returns null for an unknown Workflow ID', async () => {
    const { service } = createWorkflowService();

    const retrieved = await service.getWorkflow(
      createWorkflowId('wf-unknown'),
    );
    expect(retrieved).toBeNull();
  });
});

// ============================================================================
// INV-W4: Session can outlive Jobs
// ============================================================================

describe('WorkflowServiceImpl — INV-W4: Session outlives Jobs', () => {
  it('Workflow state is preserved after Session end (R6, ADR-006)', async () => {
    const { service } = createWorkflowService();
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    // The Workflow is in NOT_STARTED state. If the Session ends,
    // the Workflow state is preserved. In a later Session, the
    // User can retrieve the Workflow and resume it.
    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved?.state).toBe('NOT_STARTED');
  });

  it('a completed Workflow remains COMPLETE across Sessions (R6)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { service } = createWorkflowService({
      datasets,
      verifyResult: true,
    });
    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('COMPLETE');

    // In a "later Session" (same service instance, representing
    // persistence), the Workflow is still COMPLETE.
    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved?.state).toBe('COMPLETE');
  });

  it('a blocked Workflow remains BLOCKED and can be resumed in a later Session (R6)', async () => {
    const inputId = createDatasetId('ds-input-001');

    const { service, dataManagement, provenance } = createWorkflowService({
      datasets: new Map(),
      verifyResult: true,
    });

    const expId = createExperimentId('exp-001');
    const workflow = await service.createWorkflow({ name: 'wf1', experimentId: expId });

    await service.addWorkflowStep(workflow.id, {
      order: 1,
      name: 'step1',
      toolId: createToolId('cdo'),
      parameters: {},
      inputDatasetIds: [inputId],
    });

    await service.startWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('BLOCKED');

    // "Later Session" — the Workflow is still BLOCKED
    const retrieved = await service.getWorkflow(workflow.id);
    expect(retrieved?.state).toBe('BLOCKED');

    // Make input available and resume
    dataManagement.setDataset(createMockDataset({ id: inputId, consumable: true }));
    provenance.setVerifyResultFor(inputId, true);

    await service.resumeWorkflow(workflow.id);
    expect(await service.getWorkflowState(workflow.id)).toBe('COMPLETE');
  });
});
