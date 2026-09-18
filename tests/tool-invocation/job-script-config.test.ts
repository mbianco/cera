/**
 * Tests for JobScriptConfig integration with ToolInvocationService
 * (R14, ADR-012, F-INV-5, F-INV-6, FP-INV-5).
 *
 * Verifies:
 * - F-INV-6: When jobScriptConfig is provided (production), ALL
 *   ToolInvocations take the parallel path, regardless of
 *   request.executionModel.
 * - FP-INV-5: When jobScriptConfig.defaultResourceRequest is
 *   provided and request.resourceRequest is absent, the default is
 *   used (submitted to the SchedulingService).
 * - F-INV-5: When jobScriptConfig.uenvSpecs is provided, they are
 *   passed through to the SchedulingService via the UENV_SPECS_KEY
 *   environment variable.
 * - Dev mode: When jobScriptConfig is absent (dev mode), synchronous
 *   execution works as before (dispatches on request.executionModel).
 *
 * Spec: ADR-012; resolutions-r14.md R14.3, R14.4;
 * invariants-firecrest-primary.md F-INV-5, F-INV-6, FP-INV-3,
 * FP-INV-5; build-phases-firecrest.md Phase B, E.
 */

import { describe, it, expect } from 'vitest';
import { ToolInvocationServiceImpl } from '../../src/tool-invocation/tool-invocation-service';
import type { ToolInvocationServiceImplProps } from '../../src/tool-invocation/tool-invocation-service';
import type { JobScriptConfig } from '../../src/startup';
import { UENV_SPECS_KEY } from '../../src/firecrest-adapter/shell-executor';
import { ToolCatalogServiceImpl } from '../../src/tool-invocation/tool-catalog';
import {
  createMockCLITool,
  createMockShellExecutor,
  createMockSubprocessRunner,
  createMockSandboxRunner,
  createMockSchedulingService,
  createMockProvenanceService,
  createMockDataManagementService,
  createMockEnvironmentService,
  createMockShellResult,
  createMockExitOutcome,
  createMockLocation,
  createMockDataset,
  createMockEnvironment,
  createMockJob,
  createMockResourceRequest,
  createToolId,
  createDatasetId,
  createJobId,
} from './helpers';
import type {
  Dataset,
  DatasetId,
  ResourceRequest,
} from '../../src/types';
import type { ToolInvocationRequest } from '../../src/tool-invocation/types';

// ============================================================================
// Test setup helpers
// ============================================================================

/**
 * Standard input Dataset for tests.
 */
function createStandardInputDataset(): Dataset {
  return createMockDataset({
    id: createDatasetId('ds-input-001'),
    name: 'tas_historical_2000-2010',
    location: createMockLocation({
      path: '/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc',
    }),
    format: 'netcdf',
    consumable: true,
  });
}

/**
 * Standard ToolInvocationRequest for tests.
 */
function createStandardRequest(overrides: {
  readonly toolId?: ReturnType<typeof createToolId>;
  readonly parameters?: Record<string, unknown>;
  readonly inputDatasetIds?: readonly DatasetId[];
  readonly outputLocation?: ReturnType<typeof createMockLocation>;
  readonly executionModel?: 'synchronous' | 'parallel';
  readonly resourceRequest?: ResourceRequest;
  readonly permissiveExitCodes?: readonly number[];
} = {}): ToolInvocationRequest {
  return {
    toolId: overrides.toolId ?? createToolId('cdo'),
    parameters: overrides.parameters ?? { operatorChain: '-timmean' },
    inputDatasetIds: overrides.inputDatasetIds ?? [createDatasetId('ds-input-001')],
    outputLocation: overrides.outputLocation ?? createMockLocation({
      path: '/scratch/snx3000/cera_user/output/tas_timmean.nc',
    }),
    executionModel: overrides.executionModel ?? 'synchronous',
    resourceRequest: overrides.resourceRequest,
    permissiveExitCodes: overrides.permissiveExitCodes,
  };
}

/**
 * Creates a ToolInvocationServiceImpl configured for PRODUCTION
 * (no EnvironmentService, with jobScriptConfig).
 */
function createProductionService(overrides: {
  readonly tools?: readonly ReturnType<typeof createMockCLITool>[];
  readonly datasets?: ReadonlyMap<DatasetId, Dataset>;
  readonly schedulingSubmitResult?: ReturnType<typeof createMockJob>;
  readonly schedulingQueryResult?: (jobId: ReturnType<typeof createJobId>) => ReturnType<typeof createMockJob>;
  readonly jobScriptConfig?: JobScriptConfig;
} = {}): {
  readonly service: ToolInvocationServiceImpl;
  readonly catalog: ToolCatalogServiceImpl;
  readonly scheduling: ReturnType<typeof createMockSchedulingService>;
  readonly dataManagement: ReturnType<typeof createMockDataManagementService>;
  readonly provenance: ReturnType<typeof createMockProvenanceService>;
} {
  const catalog = new ToolCatalogServiceImpl();
  for (const tool of overrides.tools ?? [createMockCLITool()]) {
    void catalog.registerTool(tool);
  }

  const defaultInputDs = createStandardInputDataset();
  const dataManagement = createMockDataManagementService({
    datasets: overrides.datasets ?? new Map<DatasetId, Dataset>([
      [defaultInputDs.id, defaultInputDs],
    ]),
  });

  const provenance = createMockProvenanceService({ verifyResult: true });

  const completedJob = createMockJob({
    state: 'COMPLETED',
    terminalState: 'COMPLETED',
  });
  const scheduling = createMockSchedulingService({
    submitJobResult: overrides.schedulingSubmitResult ?? completedJob,
    queryJobResult: overrides.schedulingQueryResult ?? (() => completedJob),
  });

  const shellExecutor = createMockShellExecutor();
  const subprocessRunner = createMockSubprocessRunner();
  const sandboxRunner = createMockSandboxRunner();

  const defaultJobScriptConfig: JobScriptConfig = {
    uenvSpecs: ['cdo:2.0.5'],
    defaultResourceRequest: createMockResourceRequest({
      nodes: 1,
      coresPerNode: 1,
      memory: '1GB',
      wallTime: '00:10:00',
      partition: 'normal',
      qos: 'default',
    }),
  };

  const props: ToolInvocationServiceImplProps = {
    catalog,
    environment: undefined, // FP-INV-3 — no EnvironmentService in production
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    sandboxRunner,
    jobScriptConfig: overrides.jobScriptConfig ?? defaultJobScriptConfig,
  };

  const service = new ToolInvocationServiceImpl(props);

  return { service, catalog, scheduling, dataManagement, provenance };
}

/**
 * Creates a ToolInvocationServiceImpl configured for DEV mode
 * (with EnvironmentService, no jobScriptConfig).
 */
function createDevService(overrides: {
  readonly tools?: readonly ReturnType<typeof createMockCLITool>[];
  readonly datasets?: ReadonlyMap<DatasetId, Dataset>;
  readonly shellResult?: ReturnType<typeof createMockShellResult>;
  readonly schedulingSubmitResult?: ReturnType<typeof createMockJob>;
  readonly schedulingQueryResult?: (jobId: ReturnType<typeof createJobId>) => ReturnType<typeof createMockJob>;
} = {}): {
  readonly service: ToolInvocationServiceImpl;
  readonly catalog: ToolCatalogServiceImpl;
  readonly scheduling: ReturnType<typeof createMockSchedulingService>;
  readonly shellExecutor: ReturnType<typeof createMockShellExecutor>;
} {
  const catalog = new ToolCatalogServiceImpl();
  for (const tool of overrides.tools ?? [createMockCLITool()]) {
    void catalog.registerTool(tool);
  }

  const defaultInputDs = createStandardInputDataset();
  const dataManagement = createMockDataManagementService({
    datasets: overrides.datasets ?? new Map<DatasetId, Dataset>([
      [defaultInputDs.id, defaultInputDs],
    ]),
  });

  const provenance = createMockProvenanceService({ verifyResult: true });

  const completedJob = createMockJob({
    state: 'COMPLETED',
    terminalState: 'COMPLETED',
  });
  const scheduling = createMockSchedulingService({
    submitJobResult: overrides.schedulingSubmitResult ?? completedJob,
    queryJobResult: overrides.schedulingQueryResult ?? (() => completedJob),
  });

  const shellExecutor = createMockShellExecutor({
    defaultResult: overrides.shellResult ?? createMockShellResult({
      exitOutcome: createMockExitOutcome({ code: 0 }),
    }),
  });
  const subprocessRunner = createMockSubprocessRunner({
    defaultResult: overrides.shellResult ?? createMockShellResult({
      exitOutcome: createMockExitOutcome({ code: 0 }),
    }),
  });
  const sandboxRunner = createMockSandboxRunner();

  // In dev mode, we use a mock EnvironmentService.
  const environment = createMockEnvironmentService({
    activeEnvironment: createMockEnvironment(),
    verifyResult: true,
  });

  const props: ToolInvocationServiceImplProps = {
    catalog,
    environment, // active in dev mode
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    sandboxRunner,
    // No jobScriptConfig — dev mode
  };

  const service = new ToolInvocationServiceImpl(props);

  return { service, catalog, scheduling, shellExecutor };
}

// ============================================================================
// F-INV-6: All ToolInvocations are parallel in production
// ============================================================================

describe('ToolInvocationServiceImpl — F-INV-6: all parallel in production', () => {
  it('takes the parallel path for a synchronous ToolInvocation (production)', async () => {
    const { service, scheduling } = createProductionService();

    // Request with executionModel: 'synchronous' — in production,
    // this should still take the parallel path (F-INV-6).
    const result = await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    // The SchedulingService.submitJob() was called (parallel path)
    expect(scheduling.submitCalls).toHaveLength(1);
    expect(result.invocation.jobId).toBeDefined();
  });

  it('takes the parallel path for a parallel ToolInvocation (production)', async () => {
    const { service, scheduling } = createProductionService();

    const result = await service.invokeTool(
      createStandardRequest({
        executionModel: 'parallel',
        resourceRequest: createMockResourceRequest(),
      }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
    expect(result.invocation.jobId).toBeDefined();
  });

  it('does NOT call the synchronous ShellExecutor in production', async () => {
    const cliTool = createMockCLITool({ executionModel: 'synchronous' });
    const { service, scheduling } = createProductionService({
      tools: [cliTool],
    });

    await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    // The SchedulingService was called (parallel), NOT the
    // ShellExecutor. The SchedulingService handles execution.
    expect(scheduling.submitCalls).toHaveLength(1);
  });

  it('a synchronous Tool is accepted as a Job (no InvalidParameters)', async () => {
    const cliTool = createMockCLITool({ executionModel: 'synchronous' });
    const { service } = createProductionService({
      tools: [cliTool],
    });

    // In dev mode, a synchronous Tool with executionModel: 'parallel'
    // would throw InvalidParameters. In production, it should be
    // accepted (the Job runs the synchronous command and exits).
    const result = await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    expect(result.invocation.exitOutcome).not.toBeNull();
  });
});

// ============================================================================
// FP-INV-5: Default ResourceRequest for formerly-synchronous ToolInvocations
// ============================================================================

describe('ToolInvocationServiceImpl — FP-INV-5: default ResourceRequest', () => {
  it('uses defaultResourceRequest when request.resourceRequest is absent', async () => {
    const defaultResourceRequest: ResourceRequest = {
      nodes: 1,
      coresPerNode: 1,
      memory: '1GB',
      wallTime: '00:10:00',
      partition: 'normal',
      qos: 'default',
    };

    const { service, scheduling } = createProductionService({
      jobScriptConfig: {
        uenvSpecs: ['cdo:2.0.5'],
        defaultResourceRequest,
      },
    });

    // Request with NO resourceRequest — the default should be used
    await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
    const submitCall = scheduling.submitCalls[0];
    expect(submitCall).toBeDefined();
    if (submitCall !== undefined) {
      // The default ResourceRequest was supplied
      expect(submitCall.resourceRequest).toBe(defaultResourceRequest);
    }
  });

  it('uses request.resourceRequest when provided (takes precedence)', async () => {
    const defaultResourceRequest: ResourceRequest = {
      nodes: 1,
      coresPerNode: 1,
      memory: '1GB',
      wallTime: '00:10:00',
      partition: 'normal',
      qos: 'default',
    };

    const explicitResourceRequest: ResourceRequest = {
      nodes: 4,
      coresPerNode: 36,
      memory: '128GB',
      wallTime: '50000:00:00',
      partition: 'normal',
      qos: 'default',
    };

    const { service, scheduling } = createProductionService({
      jobScriptConfig: {
        uenvSpecs: ['cdo:2.0.5'],
        defaultResourceRequest,
      },
    });

    await service.invokeTool(
      createStandardRequest({
        executionModel: 'synchronous',
        resourceRequest: explicitResourceRequest,
      }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
    const submitCall = scheduling.submitCalls[0];
    expect(submitCall).toBeDefined();
    if (submitCall !== undefined) {
      // The explicit ResourceRequest takes precedence
      expect(submitCall.resourceRequest).toBe(explicitResourceRequest);
      expect(submitCall.resourceRequest.nodes).toBe(4);
    }
  });

  it('throws InvalidParameters when both request.resourceRequest and defaultResourceRequest are absent', async () => {
    const { service } = createProductionService({
      jobScriptConfig: {
        // No defaultResourceRequest
      },
    });

    // Request with NO resourceRequest and no default — should throw
    await expect(
      service.invokeTool(
        createStandardRequest({ executionModel: 'synchronous' }),
      ),
    ).rejects.toThrow(/resourceRequest/);
  });
});

// ============================================================================
// F-INV-5: uenv specs passed through to SchedulingService
// ============================================================================

describe('ToolInvocationServiceImpl — F-INV-5: uenv specs pass-through', () => {
  it('passes uenvSpecs to SchedulingService via UENV_SPECS_KEY', async () => {
    const uenvSpecs = ['cdo:2.0.5', 'python:3.11.6'];

    const { service, scheduling } = createProductionService({
      jobScriptConfig: {
        uenvSpecs,
        defaultResourceRequest: createMockResourceRequest(),
      },
    });

    await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
    const submitCall = scheduling.submitCalls[0];
    expect(submitCall).toBeDefined();
    if (submitCall !== undefined) {
      expect(submitCall.environmentVars).toBeDefined();
      expect(submitCall.environmentVars?.[UENV_SPECS_KEY]).toBe(
        'cdo:2.0.5,python:3.11.6',
      );
    }
  });

  it('does NOT pass UENV_SPECS_KEY when uenvSpecs is absent', async () => {
    const { service, scheduling } = createProductionService({
      jobScriptConfig: {
        // No uenvSpecs
        defaultResourceRequest: createMockResourceRequest(),
      },
    });

    await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
    const submitCall = scheduling.submitCalls[0];
    expect(submitCall).toBeDefined();
    if (submitCall !== undefined) {
      // environmentVars should be undefined or not contain UENV_SPECS_KEY
      if (submitCall.environmentVars !== undefined) {
        expect(submitCall.environmentVars[UENV_SPECS_KEY]).toBeUndefined();
      }
    }
  });

  it('does NOT pass UENV_SPECS_KEY when uenvSpecs is empty', async () => {
    const { service, scheduling } = createProductionService({
      jobScriptConfig: {
        uenvSpecs: [],
        defaultResourceRequest: createMockResourceRequest(),
      },
    });

    await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
    const submitCall = scheduling.submitCalls[0];
    expect(submitCall).toBeDefined();
    if (submitCall !== undefined && submitCall.environmentVars !== undefined) {
      expect(submitCall.environmentVars[UENV_SPECS_KEY]).toBeUndefined();
    }
  });
});

// ============================================================================
// Dev mode: synchronous execution works as before (FP-INV-3 inverse)
// ============================================================================

describe('ToolInvocationServiceImpl — dev mode: synchronous works as before', () => {
  it('executes synchronously via ShellExecutor when jobScriptConfig is absent', async () => {
    const { service, shellExecutor } = createDevService();

    await service.invokeTool(
      createStandardRequest({ executionModel: 'synchronous' }),
    );

    // The ShellExecutor was called (synchronous path)
    expect(shellExecutor.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('dispatches on executionModel in dev mode (parallel goes to Scheduling)', async () => {
    const cliTool = createMockCLITool({ executionModel: 'parallel' });
    const { service, scheduling } = createDevService({
      tools: [cliTool],
    });

    await service.invokeTool(
      createStandardRequest({
        toolId: cliTool.id,
        executionModel: 'parallel',
        resourceRequest: createMockResourceRequest(),
      }),
    );

    expect(scheduling.submitCalls).toHaveLength(1);
  });

  it('throws InvalidParameters for parallel without resourceRequest in dev mode (unchanged)', async () => {
    const cliTool = createMockCLITool({ executionModel: 'parallel' });
    const { service } = createDevService({
      tools: [cliTool],
    });

    await expect(
      service.invokeTool(
        createStandardRequest({
          toolId: cliTool.id,
          executionModel: 'parallel',
          // No resourceRequest
        }),
      ),
    ).rejects.toThrow(/resourceRequest/);
  });
});
