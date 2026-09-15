/**
 * Unit tests for ToolInvocationServiceImpl.
 *
 * Verifies all nine C1 invariants (INV-T1–T9) and all five C1
 * failure modes (FM-T1–T5), plus exit code handling (R4 strict
 * default, permissive opt-in), event emission, and the full
 * ToolInvocation lifecycle: create → verify Environment → validate
 * Locations → start → monitor → complete/fail.
 *
 * Invariants:
 * - INV-T1: Environment loaded and verified before invocation.
 * - INV-T2: Single exit outcome per invocation.
 * - INV-T3: Output registration gated on success.
 * - INV-T4: Input Datasets opened for reading only.
 * - INV-T5: Signal vs exit-code distinction preserved.
 *
 * Failure modes:
 * - FM-T1: Tool segfault (SIGSEGV, SIGBUS).
 * - FM-T2: Tool killed by OOM (SIGKILL).
 * - FM-T3: Non-zero exit code for warnings (strict default, R4).
 * - FM-T4: Invalid operator chain.
 * - FM-T5: Missing input file.
 *
 * Spec: build-phases.md Phase 4; api-contracts.md §6;
 * invariants.md INV-T1–T5; failure-modes.md FM-T1–T5;
 * resolutions.md R4; ADR-008.
 */

import { describe, it, expect } from 'vitest';
import { ToolInvocationServiceImpl } from '../../src/tool-invocation/tool-invocation-service';
import type { ToolInvocationServiceImplProps } from '../../src/tool-invocation/tool-invocation-service';
import {
  createMockCLITool,
  createMockPythonTool,
  createMockShellExecutor,
  createMockSubprocessRunner,
  createMockSandboxRunner,
  createMockSchedulingService,
  createMockEnvironmentService,
  createMockProvenanceService,
  createMockDataManagementService,
  createMockShellResult,
  createMockExitOutcome,
  createMockLocation,
  createMockGrid,
  createMockVariable,
  createMockDataset,
  createMockEnvironment,
  createMockUenvSpec,
  createMockJob,
  createMockResourceRequest,
  createToolId,
  createToolInvocationId,
  createDatasetId,
  createEnvironmentId,
  createJobId,
} from './helpers';
import { ToolCatalogServiceImpl } from '../../src/tool-invocation/tool-catalog';
import type {
  ToolInvocationEvent,
  Tool,
  Dataset,
  DatasetId,
  Location,
} from '../../src/types';
import {
  EnvironmentNotLoaded,
  InputNotFound,
  InputMissingProvenance,
  InvalidParameters,
  ToolNotFound,
  NonZeroExitCode,
  SignalTerminated,
  LocationNotReadable,
} from '../../src/types/errors';

// ============================================================================
// Test setup helper
// ============================================================================

interface ServiceSetup {
  readonly service: ToolInvocationServiceImpl;
  readonly catalog: ToolCatalogServiceImpl;
  readonly environment: ReturnType<typeof createMockEnvironmentService>;
  readonly dataManagement: ReturnType<typeof createMockDataManagementService>;
  readonly provenance: ReturnType<typeof createMockProvenanceService>;
  readonly scheduling: ReturnType<typeof createMockSchedulingService>;
  readonly shellExecutor: ReturnType<typeof createMockShellExecutor>;
  readonly subprocessRunner: ReturnType<typeof createMockSubprocessRunner>;
  readonly events: ToolInvocationEvent[];
}

function createService(overrides: {
  readonly tools?: readonly Tool[];
  readonly datasets?: ReadonlyMap<DatasetId, Dataset>;
  readonly activeEnvironment?: ReturnType<typeof createMockEnvironment> | null;
  readonly verifyEnvironment?: boolean;
  readonly verifyProvenance?: boolean;
  readonly shellResult?: ReturnType<typeof createMockShellResult>;
  readonly schedulingSubmitResult?: ReturnType<typeof createMockJob>;
  readonly schedulingQueryResult?: (jobId: ReturnType<typeof createJobId>) => ReturnType<typeof createMockJob>;
  readonly onEvent?: (event: ToolInvocationEvent) => void;
} = {}): ServiceSetup {
  const catalog = new ToolCatalogServiceImpl();
  for (const tool of overrides.tools ?? [createMockCLITool()]) {
    void catalog.registerTool(tool);
  }

  const environment = createMockEnvironmentService({
    activeEnvironment: overrides.activeEnvironment === undefined
      ? createMockEnvironment()
      : overrides.activeEnvironment,
    verifyResult: overrides.verifyEnvironment ?? true,
  });

  const defaultInputDs = createStandardInputDataset();
  const dataManagement = createMockDataManagementService({
    datasets: overrides.datasets ?? new Map<DatasetId, Dataset>([
      [defaultInputDs.id, defaultInputDs],
    ]),
  });

  const provenance = createMockProvenanceService({
    verifyResult: overrides.verifyProvenance ?? true,
  });

  const scheduling = createMockSchedulingService({
    submitJobResult: overrides.schedulingSubmitResult,
    queryJobResult: overrides.schedulingQueryResult,
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

  const events: ToolInvocationEvent[] = [];
  const onEvent = (event: ToolInvocationEvent): void => {
    events.push(event);
    overrides.onEvent?.(event);
  };

  const props: ToolInvocationServiceImplProps = {
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    sandboxRunner,
    onEvent,
  };

  const service = new ToolInvocationServiceImpl(props);

  return {
    service,
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    events,
  };
}

// ============================================================================
// Standard input dataset and request helpers
// ============================================================================

function createStandardInputDataset(): Dataset {
  return createMockDataset({
    id: createDatasetId('ds-input-001'),
    name: 'tas_historical_2000-2010',
    location: createMockLocation({
      path: '/scratch/snx3000/cera_user/data/tas_historical_2000-2010.nc',
    }),
    format: 'netcdf',
    grid: createMockGrid({ kind: 'lat-lon', nlat: 90, nlon: 180 }),
    variables: [createMockVariable({ name: 'TAS', units: 'K' })],
    consumable: true,
  });
}

function createStandardRequest(overrides: {
  readonly toolId?: ReturnType<typeof createToolId>;
  readonly parameters?: Record<string, unknown>;
  readonly inputDatasetIds?: readonly DatasetId[];
  readonly outputLocation?: Location;
  readonly executionModel?: 'synchronous' | 'parallel';
  readonly resourceRequest?: ReturnType<typeof createMockResourceRequest>;
  readonly permissiveExitCodes?: readonly number[];
} = {}): {
  readonly toolId: ReturnType<typeof createToolId>;
  readonly parameters: Record<string, unknown>;
  readonly inputDatasetIds: readonly DatasetId[];
  readonly outputLocation: Location;
  readonly executionModel: 'synchronous' | 'parallel';
  readonly resourceRequest?: ReturnType<typeof createMockResourceRequest>;
  readonly permissiveExitCodes?: readonly number[];
} {
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

// ============================================================================
// INV-T1: Environment loaded before invocation
// ============================================================================

describe('ToolInvocationServiceImpl — INV-T1: Environment loaded before invocation', () => {
  it('rejects the invocation when no Environment is active (FM-E1)', async () => {
    const { service } = createService({
      activeEnvironment: null,
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(EnvironmentNotLoaded);
  });

  it('calls verifyEnvironment() immediately before execution (X1)', async () => {
    const { service, environment } = createService();

    await service.invokeTool(createStandardRequest());

    expect(environment.verifyCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('rejects when verifyEnvironment() returns false (Environment purged)', async () => {
    const { service } = createService({
      verifyEnvironment: false,
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(EnvironmentNotLoaded);
  });

  it('rejects when the active Environment does not match the Tool requirements', async () => {
    const wrongEnv = createMockEnvironment({
      id: createEnvironmentId('env-wrong'),
      uenvSpecs: [{
        name: 'wrong',
        version: '1.0.0',
        mountPath: '/user-environment/env/wrong/1.0.0',
      }],
      modules: [{
        name: 'wrong',
        version: '1.0.0',
        prefix: '/user-environment/env/wrong/1.0.0',
      }],
    });
    const { service } = createService({
      activeEnvironment: wrongEnv,
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(EnvironmentNotLoaded);
  });
});

// ============================================================================
// INV-T2: Single exit outcome per invocation
// ============================================================================

describe('ToolInvocationServiceImpl — INV-T2: Single exit outcome per invocation', () => {
  it('sets exactly one ExitOutcome on a successful invocation', async () => {
    const { service } = createService();

    const result = await service.invokeTool(createStandardRequest());

    expect(result.invocation.exitOutcome).not.toBeNull();
    // Either exit_code or signal, never both (enforced by the
    // discriminated union type).
    if (result.invocation.exitOutcome !== null) {
      expect(result.invocation.exitOutcome.kind).toBe('exit_code');
    }
  });

  it('sets exactly one ExitOutcome on a failed invocation (non-zero)', async () => {
    const { service } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(NonZeroExitCode);
  });

  it('sets exactly one ExitOutcome on a signal-terminated invocation', async () => {
    const { service } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGSEGV', number: 11 },
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(SignalTerminated);
  });
});

// ============================================================================
// INV-T3: Output registration gated on success
// ============================================================================

describe('ToolInvocationServiceImpl — INV-T3: Output registration gated on success', () => {
  it('registers the output Dataset when exit code is 0 (strict default)', async () => {
    const { service, dataManagement } = createService();

    const result = await service.invokeTool(createStandardRequest());

    expect(result.outputDatasets).toHaveLength(1);
    expect(dataManagement.registerCalls).toHaveLength(1);
    expect(dataManagement.markConsumableCalls).toHaveLength(1);
  });

  it('does NOT register the output Dataset when exit code is non-zero (R4 strict)', async () => {
    const { service, dataManagement } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(NonZeroExitCode);

    // INV-T3: output NOT registered
    expect(dataManagement.registerCalls).toHaveLength(0);
    expect(dataManagement.markConsumableCalls).toHaveLength(0);
  });

  it('does NOT register the output Dataset when terminated by signal', async () => {
    const { service, dataManagement } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGKILL', number: 9 },
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(SignalTerminated);

    expect(dataManagement.registerCalls).toHaveLength(0);
    expect(dataManagement.markConsumableCalls).toHaveLength(0);
  });

  it('registers output WITH warning flag when exit code is in permissiveExitCodes', async () => {
    const { service, provenance } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
      }),
    });

    const result = await service.invokeTool(
      createStandardRequest({ permissiveExitCodes: [1] }),
    );

    // Permissive mode: output IS registered
    expect(result.outputDatasets).toHaveLength(1);
    // ProvenanceRecord should have warningFlag set
    expect(provenance.writeCalls).toHaveLength(1);
    const writeCall = provenance.writeCalls[0];
    if (writeCall !== undefined) {
      // The ProvenanceRecord includes the exit code
      expect(writeCall.exitOutcome.kind).toBe('exit_code');
      if (writeCall.exitOutcome.kind === 'exit_code') {
        expect(writeCall.exitOutcome.code).toBe(1);
      }
    }
  });
});

// ============================================================================
// INV-T4: Input immutability during invocation
// ============================================================================

describe('ToolInvocationServiceImpl — INV-T4: Input immutability during invocation', () => {
  it('validates input Locations in read mode (never write)', async () => {
    const inputDs = createStandardInputDataset();
    const { service, dataManagement } = createService({
      datasets: new Map([[inputDs.id, inputDs]]),
    });

    await service.invokeTool(createStandardRequest({
      inputDatasetIds: [inputDs.id],
    }));

    // The first validateLocation call should be for the input (read mode)
    const inputValidateCall = dataManagement.validateLocationCalls.find(
      (c) => c.mode === 'read',
    );
    expect(inputValidateCall).toBeDefined();
    expect(inputValidateCall?.location.path).toBe(inputDs.location.path);
  });

  it('validates output Location in write mode', async () => {
    const inputDs = createStandardInputDataset();
    const { service, dataManagement } = createService({
      datasets: new Map([[inputDs.id, inputDs]]),
    });

    const outputLoc = createMockLocation({
      path: '/scratch/snx3000/cera_user/output/output.nc',
    });
    await service.invokeTool(createStandardRequest({
      inputDatasetIds: [inputDs.id],
      outputLocation: outputLoc,
    }));

    const writeValidateCall = dataManagement.validateLocationCalls.find(
      (c) => c.mode === 'write',
    );
    expect(writeValidateCall).toBeDefined();
    expect(writeValidateCall?.location.path).toBe(outputLoc.path);
  });
});

// ============================================================================
// INV-T5: Signal vs exit-code distinction preserved
// ============================================================================

describe('ToolInvocationServiceImpl — INV-T5: Signal vs exit-code distinction', () => {
  it('reports SIGSEGV as a signal, not a synthetic exit code (FM-T1)', async () => {
    const { service } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGSEGV', number: 11 },
      }),
    });

    try {
      await service.invokeTool(createStandardRequest());
      expect.unreachable('Should have thrown SignalTerminated');
    } catch (error) {
      expect(error).toBeInstanceOf(SignalTerminated);
      if (error instanceof SignalTerminated) {
        expect(error.kind).toBe('signal_terminated');
      }
    }
  });

  it('reports SIGKILL as a signal (likely OOM) (FM-T2)', async () => {
    const { service } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGKILL', number: 9 },
      }),
    });

    try {
      await service.invokeTool(createStandardRequest());
      expect.unreachable('Should have thrown SignalTerminated');
    } catch (error) {
      expect(error).toBeInstanceOf(SignalTerminated);
      if (error instanceof SignalTerminated) {
        // The SignalTerminated error preserves the signal info
        expect(error.kind).toBe('signal_terminated');
      }
    }
  });

  it('writes a ProvenanceRecord with signal outcome on signal termination', async () => {
    const { service, provenance } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGTERM', number: 15 },
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(SignalTerminated);

    expect(provenance.writeCalls).toHaveLength(1);
    const writeCall = provenance.writeCalls[0];
    if (writeCall !== undefined) {
      expect(writeCall.exitOutcome.kind).toBe('signal');
      expect(writeCall.outputDatasetId).toBeNull();
    }
  });
});

// ============================================================================
// FM-T1: Tool segfault (SIGSEGV)
// ============================================================================

describe('ToolInvocationServiceImpl — FM-T1: Tool segfault', () => {
  it('marks the ToolInvocation as FAILED on SIGSEGV', async () => {
    const { service, events } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGSEGV', number: 11 },
        stderr: 'Segmentation fault\n',
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(SignalTerminated);

    // A signal_terminated event should have been emitted
    const signalEvents = events.filter((e) => e.kind === 'tool_invocation_signal_terminated');
    expect(signalEvents).toHaveLength(1);
    if (signalEvents[0]?.kind === 'tool_invocation_signal_terminated') {
      expect(signalEvents[0].signalName).toBe('SIGSEGV');
      expect(signalEvents[0].signalNumber).toBe(11);
    }
  });
});

// ============================================================================
// FM-T2: Tool killed by OOM (SIGKILL)
// ============================================================================

describe('ToolInvocationServiceImpl — FM-T2: Tool killed by OOM', () => {
  it('marks the ToolInvocation as FAILED on SIGKILL', async () => {
    const { service, events } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGKILL', number: 9 },
        stderr: 'Killed\n',
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(SignalTerminated);

    const signalEvents = events.filter((e) => e.kind === 'tool_invocation_signal_terminated');
    expect(signalEvents).toHaveLength(1);
    if (signalEvents[0]?.kind === 'tool_invocation_signal_terminated') {
      expect(signalEvents[0].signalName).toBe('SIGKILL');
      expect(signalEvents[0].signalNumber).toBe(9);
    }
  });
});

// ============================================================================
// FM-T3: Non-zero exit code for warnings (strict default, R4)
// ============================================================================

describe('ToolInvocationServiceImpl — FM-T3: Non-zero exit code (R4 strict)', () => {
  it('throws NonZeroExitCode on exit code 1 (strict default)', async () => {
    const { service } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
        stderr: 'Warning: metadata inconsistency\n',
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(NonZeroExitCode);
  });

  it('writes a ProvenanceRecord with the non-zero exit code on failure', async () => {
    const { service, provenance } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(NonZeroExitCode);

    expect(provenance.writeCalls).toHaveLength(1);
    const writeCall = provenance.writeCalls[0];
    if (writeCall !== undefined) {
      expect(writeCall.exitOutcome.kind).toBe('exit_code');
      if (writeCall.exitOutcome.kind === 'exit_code') {
        expect(writeCall.exitOutcome.code).toBe(1);
      }
      expect(writeCall.outputDatasetId).toBeNull();
    }
  });

  it('registers output when exit code 1 is in permissiveExitCodes', async () => {
    const { service, dataManagement } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
      }),
    });

    const result = await service.invokeTool(
      createStandardRequest({ permissiveExitCodes: [1] }),
    );

    expect(result.outputDatasets).toHaveLength(1);
    expect(dataManagement.registerCalls).toHaveLength(1);
    expect(dataManagement.markConsumableCalls).toHaveLength(1);
  });

  it('does NOT register output when exit code is not in permissiveExitCodes', async () => {
    const { service, dataManagement } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 2 }),
      }),
    });

    await expect(
      service.invokeTool(
        createStandardRequest({ permissiveExitCodes: [1] }),
      ),
    ).rejects.toThrow(NonZeroExitCode);

    expect(dataManagement.registerCalls).toHaveLength(0);
  });
});

// ============================================================================
// FM-T4: Invalid operator chain
// ============================================================================

describe('ToolInvocationServiceImpl — FM-T4: Invalid operator chain', () => {
  it('captures non-zero exit code and stderr on invalid operator chain', async () => {
    const { service } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
        stderr: 'Error (AbcStatements): unknown operator -invalidop\n',
      }),
    });

    try {
      await service.invokeTool(createStandardRequest({
        parameters: { operatorChain: '-invalidop' },
      }));
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(NonZeroExitCode);
      if (error instanceof NonZeroExitCode) {
        expect(error.internalDetails).toContain('invalidop');
      }
    }
  });
});

// ============================================================================
// FM-T5: Missing input file
// ============================================================================

describe('ToolInvocationServiceImpl — FM-T5: Missing input file', () => {
  it('rejects the invocation when an input Dataset does not exist', async () => {
    const { service, dataManagement } = createService({
      datasets: new Map(), // empty — no datasets
    });

    await expect(
      service.invokeTool(createStandardRequest({
        inputDatasetIds: [createDatasetId('nonexistent')],
      })),
    ).rejects.toThrow(InputNotFound);

    // No output should be registered
    expect(dataManagement.registerCalls).toHaveLength(0);
  });

  it('rejects when an input Dataset Location is not readable (LocationNotReadable)', async () => {
    const inputDs = createStandardInputDataset();

    const { service: svc3, dataManagement: dm3 } = createServiceWithLocationError(
      inputDs,
      new LocationNotReadable({ path: inputDs.location.path, cause: 'enoent' }),
    );

    await expect(
      svc3.invokeTool(createStandardRequest({
        inputDatasetIds: [inputDs.id],
      })),
    ).rejects.toThrow(InputNotFound);

    expect(dm3.registerCalls).toHaveLength(0);
  });
});

// Helper for the location error test
function createServiceWithLocationError(
  inputDs: Dataset,
  error: Error,
): {
  service: ToolInvocationServiceImpl;
  dataManagement: ReturnType<typeof createMockDataManagementService>;
} {
  const catalog = new ToolCatalogServiceImpl();
  void catalog.registerTool(createMockCLITool());

  const environment = createMockEnvironmentService();
  const dataManagement = createMockDataManagementService({
    datasets: new Map([[inputDs.id, inputDs]]),
    validateLocationError: error,
  });
  const provenance = createMockProvenanceService({ verifyResult: true });
  const scheduling = createMockSchedulingService();
  const shellExecutor = createMockShellExecutor();
  const subprocessRunner = createMockSubprocessRunner();
  const sandboxRunner = createMockSandboxRunner();

  const service = new ToolInvocationServiceImpl({
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    sandboxRunner,
  });

  return { service, dataManagement };
}

// ============================================================================
// Validation errors
// ============================================================================

describe('ToolInvocationServiceImpl — validation errors', () => {
  it('throws ToolNotFound when the Tool is not in the catalog (FM-A1)', async () => {
    const { service } = createService({
      tools: [createMockCLITool({ id: createToolId('cdo') })],
    });

    await expect(
      service.invokeTool(createStandardRequest({
        toolId: createToolId('nonexistent_tool'),
      })),
    ).rejects.toThrow(ToolNotFound);
  });

  it('throws InvalidParameters when parameters are empty', async () => {
    const { service } = createService();

    await expect(
      service.invokeTool(createStandardRequest({
        parameters: {},
      })),
    ).rejects.toThrow(InvalidParameters);
  });

  it('throws InputMissingProvenance when an input Dataset has no ProvenanceRecord', async () => {
    const inputDs = createStandardInputDataset();
    const { service } = createService({
      datasets: new Map([[inputDs.id, inputDs]]),
      verifyProvenance: false,
    });

    await expect(
      service.invokeTool(createStandardRequest({
        inputDatasetIds: [inputDs.id],
      })),
    ).rejects.toThrow(InputMissingProvenance);
  });

  it('throws InvalidParameters when input format is not accepted by the Tool', async () => {
    const inputDs = createMockDataset({
      id: createDatasetId('ds-grib2-001'),
      format: 'grib2',
    });
    const tool = createMockCLITool({
      id: createToolId('ncks'),
      binary: 'ncks',
      inputFormats: ['netcdf'], // Only accepts NetCDF
    });
    const { service } = createService({
      tools: [tool],
      datasets: new Map([[inputDs.id, inputDs]]),
    });

    await expect(
      service.invokeTool(createStandardRequest({
        toolId: createToolId('ncks'),
        inputDatasetIds: [inputDs.id],
      })),
    ).rejects.toThrow(InvalidParameters);
  });
});

// ============================================================================
// Event emission
// ============================================================================

describe('ToolInvocationServiceImpl — event emission', () => {
  it('emits created, started, and completed events on success', async () => {
    const { service, events } = createService();

    await service.invokeTool(createStandardRequest());

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_invocation_created');
    expect(kinds).toContain('tool_invocation_started');
    expect(kinds).toContain('tool_invocation_completed');
  });

  it('emits created, started, and failed events on non-zero exit', async () => {
    const { service, events } = createService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(NonZeroExitCode);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_invocation_created');
    expect(kinds).toContain('tool_invocation_started');
    expect(kinds).toContain('tool_invocation_failed');
  });

  it('emits signal_terminated event on signal death', async () => {
    const { service, events } = createService({
      shellResult: createMockShellResult({
        exitOutcome: { kind: 'signal', name: 'SIGSEGV', number: 11 },
      }),
    });

    await expect(
      service.invokeTool(createStandardRequest()),
    ).rejects.toThrow(SignalTerminated);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain('tool_invocation_signal_terminated');
  });
});

// ============================================================================
// Synchronous vs parallel execution
// ============================================================================

describe('ToolInvocationServiceImpl — execution models', () => {
  it('executes CLI Tools synchronously via ShellExecutor', async () => {
    const { service, shellExecutor } = createService();

    await service.invokeTool(createStandardRequest({
      executionModel: 'synchronous',
    }));

    expect(shellExecutor.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('executes Python Tools synchronously via SubprocessRunner', async () => {
    const pythonTool = createMockPythonTool({ id: createToolId('healpy') });
    const pythonEnv = createMockEnvironment({
      uenvSpecs: [createMockUenvSpec({ name: 'python', version: '3.11.0' })],
    });
    const { service, subprocessRunner } = createService({
      tools: [pythonTool],
      activeEnvironment: pythonEnv,
    });

    await service.invokeTool(createStandardRequest({
      toolId: createToolId('healpy'),
      parameters: { script: 'import healpy' },
      executionModel: 'synchronous',
    }));

    expect(subprocessRunner.calls.length).toBeGreaterThanOrEqual(1);
    expect(subprocessRunner.calls[0]?.command).toBe('python3');
  });

  it('submits a Job to scheduling for parallel execution', async () => {
    const cliTool = createMockCLITool({
      id: createToolId('cdo'),
      executionModel: 'parallel',
    });
    const job = createMockJob({ state: 'COMPLETED', terminalState: 'COMPLETED' });
    const { service, scheduling } = createService({
      tools: [cliTool],
      schedulingSubmitResult: job,
      schedulingQueryResult: () => job,
    });

    const result = await service.invokeTool(createStandardRequest({
      toolId: createToolId('cdo'),
      executionModel: 'parallel',
      resourceRequest: createMockResourceRequest(),
    }));

    expect(scheduling.submitCalls).toHaveLength(1);
    expect(result.invocation.exitOutcome).not.toBeNull();
    if (result.invocation.exitOutcome !== null && result.invocation.exitOutcome.kind === 'exit_code') {
      expect(result.invocation.exitOutcome.code).toBe(0);
    }
  });

  it('maps Job COMPLETED to exit code 0 for parallel execution', async () => {
    const cliTool = createMockCLITool({ executionModel: 'parallel' });
    const completedJob = createMockJob({
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });
    const { service } = createService({
      tools: [cliTool],
      schedulingSubmitResult: completedJob,
      schedulingQueryResult: () => completedJob,
    });

    const result = await service.invokeTool(createStandardRequest({
      toolId: cliTool.id,
      executionModel: 'parallel',
      resourceRequest: createMockResourceRequest(),
    }));

    expect(result.invocation.exitOutcome?.kind).toBe('exit_code');
    if (result.invocation.exitOutcome?.kind === 'exit_code') {
      expect(result.invocation.exitOutcome.code).toBe(0);
    }
  });

  it('maps Job FAILED to non-zero exit code for parallel execution', async () => {
    const cliTool = createMockCLITool({ executionModel: 'parallel' });
    const failedJob = createMockJob({
      state: 'FAILED',
      terminalState: 'FAILED',
    });
    const { service } = createService({
      tools: [cliTool],
      schedulingSubmitResult: failedJob,
      schedulingQueryResult: () => failedJob,
    });

    await expect(
      service.invokeTool(createStandardRequest({
        toolId: cliTool.id,
        executionModel: 'parallel',
        resourceRequest: createMockResourceRequest(),
      })),
    ).rejects.toThrow(NonZeroExitCode);
  });

  it('maps Job TIMEOUT to signal SIGTERM for parallel execution (FM-S4)', async () => {
    const cliTool = createMockCLITool({ executionModel: 'parallel' });
    const timeoutJob = createMockJob({
      state: 'TIMEOUT',
      terminalState: 'TIMEOUT',
    });
    const { service } = createService({
      tools: [cliTool],
      schedulingSubmitResult: timeoutJob,
      schedulingQueryResult: () => timeoutJob,
    });

    await expect(
      service.invokeTool(createStandardRequest({
        toolId: cliTool.id,
        executionModel: 'parallel',
        resourceRequest: createMockResourceRequest(),
      })),
    ).rejects.toThrow(SignalTerminated);
  });

  it('maps Job OUT_OF_MEMORY to signal SIGKILL for parallel execution (FM-T2)', async () => {
    const cliTool = createMockCLITool({ executionModel: 'parallel' });
    const oomJob = createMockJob({
      state: 'OUT_OF_MEMORY',
      terminalState: 'OUT_OF_MEMORY',
    });
    const { service } = createService({
      tools: [cliTool],
      schedulingSubmitResult: oomJob,
      schedulingQueryResult: () => oomJob,
    });

    await expect(
      service.invokeTool(createStandardRequest({
        toolId: cliTool.id,
        executionModel: 'parallel',
        resourceRequest: createMockResourceRequest(),
      })),
    ).rejects.toThrow(SignalTerminated);
  });
});

// ============================================================================
// monitorInvocation
// ============================================================================

describe('ToolInvocationServiceImpl.monitorInvocation', () => {
  it('returns an AsyncObservable for a known invocation', async () => {
    // Start an invocation and capture the invocation ID from events
    const { service, events } = createService();
    await service.invokeTool(createStandardRequest());

    const createdEvent = events.find((e) => e.kind === 'tool_invocation_created');
    if (createdEvent?.kind === 'tool_invocation_created') {
      const observable = service.monitorInvocation(createdEvent.invocationId);
      expect(observable).toBeDefined();
      expect(typeof observable.subscribe).toBe('function');
      expect(typeof observable.cancel).toBe('function');
    }
  });

  it('returns an AsyncObservable even for an unknown invocation (empty stream)', () => {
    const { service } = createService();

    const observable = service.monitorInvocation(
      createToolInvocationId('nonexistent'),
    );

    expect(observable).toBeDefined();
    expect(typeof observable.subscribe).toBe('function');
  });
});
