/**
 * Unit tests for the WorkflowExecutor helper.
 *
 * Verifies sequential step execution, INV-W1 (step inputs exist
 * before start), and INV-W2 (failure halts downstream).
 *
 * The WorkflowExecutor:
 * 1. Verifies all input Datasets exist (via dataManagement) and
 *    have Provenance (via provenance) — INV-W1.
 * 2. Gets the Tool from the catalog to determine its kind.
 * 3. If ModelTool (kind === 'model'): delegates to caseService.
 * 4. If CLI/Python Tool: delegates to toolInvocation.invokeTool().
 * 5. Returns the result (completed, failed, blocked, or waiting).
 *
 * Spec: build-phases.md Phase 5; api-contracts.md §7 (Workflow);
 * invariants.md INV-W1, INV-W2; resolutions.md R6; ADR-006.
 */

import { describe, it, expect } from 'vitest';
import { WorkflowExecutor } from '../../src/agent-interaction/workflow-executor';
import type { WorkflowExecutorProps } from '../../src/agent-interaction/workflow-executor';
import type { Tool, DatasetId, ToolId } from '../../src/types';
import {
  createMockDataManagementService,
  createMockProvenanceService,
  createMockToolInvocationService,
  createMockCaseService,
  createMockToolCatalogService,
  createMockCLITool,
  createMockModelTool,
  createMockDataset,
  createMockWorkflowStep,
  createMockCase,
  createDatasetId,
  createToolId,
  createJobId,
  createCaseId,
} from './helpers';

// ============================================================================
// Test setup helper
// ============================================================================

interface ExecutorSetup {
  readonly executor: WorkflowExecutor;
  readonly dataManagement: ReturnType<typeof createMockDataManagementService>;
  readonly provenance: ReturnType<typeof createMockProvenanceService>;
  readonly toolInvocation: ReturnType<typeof createMockToolInvocationService>;
  readonly caseService: ReturnType<typeof createMockCaseService>;
  readonly catalog: ReturnType<typeof createMockToolCatalogService>;
}

function createExecutor(overrides: {
  readonly tools?: readonly Tool[];
  readonly datasets?: ReadonlyMap<DatasetId, import('../../src/types').Dataset>;
  readonly verifyResult?: boolean;
  readonly verifyResults?: ReadonlyMap<DatasetId, boolean>;
  readonly invocationResult?: import('../../src/tool-invocation/types').ToolInvocationResult;
  readonly invocationError?: Error;
  readonly caseResult?: import('../../src/types').Case;
  readonly caseError?: Error;
  readonly config?: Partial<{ readonly pollIntervalMs: number; readonly outputBasePath: string }>;
} = {}): ExecutorSetup {
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

  const props: WorkflowExecutorProps = {
    dataManagement,
    provenance,
    toolInvocation,
    caseService,
    catalog,
    config: overrides.config,
  };

  const executor = new WorkflowExecutor(props);

  return {
    executor,
    dataManagement,
    provenance,
    toolInvocation,
    caseService,
    catalog,
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
  const dataset = createMockDataset({
    id: inputId,
    name: 'tas_historical_2000-2010',
    consumable: true,
  });
  const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
    [inputId, dataset],
  ]);
  return { datasets, inputId };
}

// ============================================================================
// INV-W1: Step inputs must exist with Provenance
// ============================================================================

describe('WorkflowExecutor — INV-W1: Step inputs must exist', () => {
  it('executes a step when all inputs exist and have Provenance', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { executor } = createExecutor({
      datasets,
      verifyResult: true,
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('cdo'),
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('completed');
  });

  it('blocks the step when an input Dataset does not exist (INV-W1)', async () => {
    const { executor } = createExecutor({
      datasets: new Map(),
      verifyResult: true,
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [createDatasetId('ds-nonexistent')],
      toolId: createToolId('cdo'),
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.missingInputs.length).toBe(1);
      expect(result.missingInputs[0]?.datasetId).toBe('ds-nonexistent' as DatasetId);
      expect(result.missingInputs[0]?.reason).toBe('not_found');
    }
  });

  it('blocks the step when an input Dataset exists but lacks Provenance (INV-W1, INV-D3)', async () => {
    const inputId = createDatasetId('ds-no-provenance');
    const dataset = createMockDataset({ id: inputId, consumable: false });
    const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
      [inputId, dataset],
    ]);

    const { executor } = createExecutor({
      datasets,
      verifyResult: false, // No Provenance
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('cdo'),
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.missingInputs[0]?.datasetId).toBe(inputId);
      expect(result.missingInputs[0]?.reason).toBe('no_provenance');
    }
  });

  it('blocks when some inputs exist but others do not (INV-W1)', async () => {
    const existingId = createDatasetId('ds-existing');
    const existingDs = createMockDataset({ id: existingId, consumable: true });
    const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
      [existingId, existingDs],
    ]);

    const { executor } = createExecutor({
      datasets,
      verifyResult: true,
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [existingId, createDatasetId('ds-missing')],
      toolId: createToolId('cdo'),
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.missingInputs.length).toBe(1);
      expect(result.missingInputs[0]?.reason).toBe('not_found');
    }
  });

  it('does not execute the Tool when inputs are missing (INV-W1)', async () => {
    const { executor, toolInvocation } = createExecutor({
      datasets: new Map(),
      verifyResult: true,
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [createDatasetId('ds-nonexistent')],
      toolId: createToolId('cdo'),
    });

    await executor.executeStep(step);

    expect(toolInvocation.invokeCalls.length).toBe(0);
  });
});

// ============================================================================
// INV-W2: Failure halts downstream
// ============================================================================

describe('WorkflowExecutor — INV-W2: Failure halts downstream', () => {
  it('returns failed when the ToolInvocation throws (INV-W2)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { executor } = createExecutor({
      datasets,
      verifyResult: true,
      invocationError: new Error('CDO exited with code 2'),
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('cdo'),
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.downstreamHalted).toBe(true);
      expect(result.reason).toContain('CDO exited with code 2');
    }
  });

  it('downstreamHalted is always true for failed steps (INV-W2)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { executor } = createExecutor({
      datasets,
      verifyResult: true,
      invocationError: new Error('Tool crashed'),
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('cdo'),
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      // INV-W2: downstream steps do not start automatically
      expect(result.downstreamHalted).toBe(true);
    }
  });
});

// ============================================================================
// Tool kind routing (ModelTool → caseService, CLI/Python → toolInvocation)
// ============================================================================

describe('WorkflowExecutor — Tool kind routing', () => {
  it('delegates to toolInvocation.invokeTool() for CLI Tools', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const cliTool = createMockCLITool({ id: createToolId('cdo') });
    const { executor, toolInvocation } = createExecutor({
      tools: [cliTool],
      datasets,
      verifyResult: true,
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('cdo'),
    });

    await executor.executeStep(step);

    expect(toolInvocation.invokeCalls.length).toBe(1);
    expect(toolInvocation.invokeCalls[0]?.toolId).toBe('cdo' as ToolId);
  });

  it('delegates to caseService.submitCase() for Model Tools (CESM)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const modelTool = createMockModelTool({ id: createToolId('cesm') });
    const cesmCase = createMockCase({
      id: createCaseId('case-001'),
      state: 'BUILT',
    });

    const { executor, caseService, toolInvocation } = createExecutor({
      tools: [modelTool],
      datasets,
      verifyResult: true,
      caseResult: cesmCase,
    });

    // The step's parameters must contain a caseId for CESM
    const step = createMockWorkflowStep({
      name: 'cesm_run',
      toolId: createToolId('cesm'),
      inputDatasetIds: [inputId],
      parameters: { caseId: createCaseId('case-001') },
      executionModel: 'parallel',
      resourceRequest: {
        nodes: 128,
        coresPerNode: 36,
        memory: '128GB',
        wallTime: '168:00:00',
        partition: 'normal',
        qos: 'default',
      },
    });

    await executor.executeStep(step);

    // Should NOT call toolInvocation.invokeTool() for Model Tools
    expect(toolInvocation.invokeCalls.length).toBe(0);

    // Should call caseService.submitCase()
    expect(caseService.submitCalls.length).toBe(1);
    expect(caseService.submitCalls[0]?.caseId).toBe('case-001' as import('../../src/types').CaseId);
  });

  it('returns waiting when a CESM step submits a Job', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const modelTool = createMockModelTool({ id: createToolId('cesm') });
    const submittedCase = createMockCase({
      id: createCaseId('case-001'),
      state: 'SUBMITTED',
      jobId: createJobId(4827365),
    });

    const { executor } = createExecutor({
      tools: [modelTool],
      datasets,
      verifyResult: true,
      caseResult: submittedCase,
    });

    const step = createMockWorkflowStep({
      name: 'cesm_run',
      toolId: createToolId('cesm'),
      inputDatasetIds: [inputId],
      parameters: { caseId: createCaseId('case-001') },
      executionModel: 'parallel',
      resourceRequest: {
        nodes: 128,
        coresPerNode: 36,
        memory: '128GB',
        wallTime: '168:00:00',
        partition: 'normal',
        qos: 'default',
      },
    });

    const result = await executor.executeStep(step);

    // The step is waiting for the Job to complete
    expect(result.kind).toBe('waiting');
    if (result.kind === 'waiting') {
      expect(result.jobId).toBe(4827365);
    }
  });

  it('throws when the Tool is not in the catalog (FM-A1)', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { executor } = createExecutor({
      tools: [], // empty catalog
      datasets,
      verifyResult: true,
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('nonexistent-tool'),
    });

    const result = await executor.executeStep(step);

    // When the Tool is not in the catalog, the step fails
    expect(result.kind).toBe('failed');
    if (result.kind === 'failed') {
      expect(result.reason).toContain('nonexistent-tool');
    }
  });

  it('returns completed with outputDatasetId for successful CLI steps', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const outputId = createDatasetId('ds-output-001');

    const { executor } = createExecutor({
      datasets,
      verifyResult: true,
      invocationResult: {
        invocation: {
          id: 'ti-001' as import('../../src/types').ToolInvocationId,
          toolId: createToolId('cdo'),
          parameters: {},
          inputDatasetIds: [inputId],
          outputDatasetIds: [outputId],
          environmentId: 'env-001' as import('../../src/types').EnvironmentId,
          state: 'COMPLETED',
          exitOutcome: { kind: 'exit_code', code: 0 },
          permissiveExitCodes: [],
          executionModel: 'synchronous',
          createdAt: new Date(),
          startedAt: new Date(),
          completedAt: new Date(),
        },
        outputDatasets: [
          createMockDataset({ id: outputId, name: 'tas_only' }),
        ],
        provenanceRecord: {
          id: 'pr-001' as import('../../src/types').ProvenanceRecordId,
          toolId: createToolId('cdo'),
          toolName: 'cdo',
          toolVersion: '2.0.5',
          parameters: {},
          environmentId: 'env-001' as import('../../src/types').EnvironmentId,
          environmentDescription: 'cdo/2.0.5',
          inputDatasetIds: [inputId],
          outputDatasetId: outputId,
          exitOutcome: { kind: 'exit_code', code: 0 },
          timestamp: new Date(),
        },
      },
    });

    const step = createMockWorkflowStep({
      inputDatasetIds: [inputId],
      toolId: createToolId('cdo'),
      outputDatasetId: outputId,
    });

    const result = await executor.executeStep(step);

    expect(result.kind).toBe('completed');
    if (result.kind === 'completed') {
      expect(result.outputDatasetId).toBe(outputId);
    }
  });
});

// ============================================================================
// Step verification helper
// ============================================================================

describe('WorkflowExecutor — verifyStepInputs', () => {
  it('returns empty array when all inputs exist and have Provenance', async () => {
    const { datasets, inputId } = createStandardInputDatasets();
    const { executor } = createExecutor({
      datasets,
      verifyResult: true,
    });

    const missing = await executor.verifyStepInputs([inputId]);

    expect(missing.length).toBe(0);
  });

  it('returns missing entries for non-existent Datasets', async () => {
    const { executor } = createExecutor({
      datasets: new Map(),
      verifyResult: true,
    });

    const missing = await executor.verifyStepInputs([
      createDatasetId('ds-nonexistent'),
    ]);

    expect(missing.length).toBe(1);
    expect(missing[0]?.reason).toBe('not_found');
  });

  it('returns missing entries for Datasets without Provenance', async () => {
    const inputId = createDatasetId('ds-no-prov');
    const dataset = createMockDataset({ id: inputId });
    const datasets = new Map<DatasetId, import('../../src/types').Dataset>([
      [inputId, dataset],
    ]);

    const { executor } = createExecutor({
      datasets,
      verifyResult: false,
    });

    const missing = await executor.verifyStepInputs([inputId]);

    expect(missing.length).toBe(1);
    expect(missing[0]?.reason).toBe('no_provenance');
  });
});
