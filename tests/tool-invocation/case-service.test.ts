/**
 * Unit tests for CaseServiceImpl.
 *
 * Verifies the full CESM Case lifecycle (create → configure → build →
 * submit → monitor → post-process), all four Case-specific invariants
 * (INV-T6–T9), all five CESM failure modes (FM-M1–M5), and
 * ProvenanceRecord writing for each step.
 *
 * Invariants:
 * - INV-T6: Submit requires built Case (submitCase rejects if not
 *   BUILT).
 * - INV-T7: One running Job per Case (submitCase rejects if a Job
 *   is already RUNNING or PENDING).
 * - INV-T8: Run length bounded by Wall Time.
 * - INV-T9: Output tree location known before submission (set at
 *   creation per R5).
 *
 * Failure modes:
 * - FM-M1: CESM build failure (non-zero exit) → Case remains
 *   CONFIGURED, throws NonZeroExitCode.
 * - FM-M2: CESM runtime crash (Job state FAILED) → monitorCase
 *   emits FAILED.
 * - FM-M3: Wall time exceeded (Job state TIMEOUT) → monitorCase
 *   emits FAILED.
 * - FM-M4: Node failure (Job state NODE_FAIL) → monitorCase emits
 *   FAILED.
 * - FM-M5: CESM configure failure (non-zero exit) → Case remains
 *   CREATED, throws NonZeroExitCode.
 *
 * Spec: build-phases.md Phase 4; api-contracts.md §6 (CaseService);
 * invariants.md INV-T6–T9; failure-modes.md FM-M1–M5;
 * resolutions.md R1, R4, R5, R8.
 */

import { describe, it, expect } from 'vitest';
import { CaseServiceImpl } from '../../src/tool-invocation/case-service';
import type { CaseServiceImplProps, OutputFile, OutputScanner } from '../../src/tool-invocation/case-service';
import { runLengthExceedsWallTime } from '../../src/tool-invocation/case-service';
import { ToolCatalogServiceImpl } from '../../src/tool-invocation/tool-catalog';
import type {
  Case,
  CaseState,
  Duration,
  Job,
  JobId,
  JobState,
  Location,
  ResourceRequest,
  Tool,
} from '../../src/types';
import type { ExperimentId } from '../../src/types';
import {
  CaseAlreadyRunning,
  CaseNotBuilt,
  EnvironmentNotLoaded,
  InvalidParameters,
  NonZeroExitCode,
  RunLengthExceedsWallTime as RunLengthExceedsWallTimeError,
  ToolNotFound,
} from '../../src/types/errors';
import {
  createJobId,
  createMockDataManagementService,
  createMockEnvironment,
  createMockEnvironmentService,
  createMockExitOutcome,
  createMockGrid,
  createMockJob,
  createMockModelTool,
  createMockProvenanceService,
  createMockResourceRequest,
  createMockSchedulingService,
  createMockShellExecutor,
  createMockShellResult,
  createMockSubprocessRunner,
  createMockVariable,
  createMockCLITool,
  createMockUenvSpec,
} from './helpers';

// ============================================================================
// Test setup helper
// ============================================================================

interface CaseServiceSetup {
  readonly service: CaseServiceImpl;
  readonly catalog: ToolCatalogServiceImpl;
  readonly environment: ReturnType<typeof createMockEnvironmentService>;
  readonly dataManagement: ReturnType<typeof createMockDataManagementService>;
  readonly provenance: ReturnType<typeof createMockProvenanceService>;
  readonly scheduling: ReturnType<typeof createMockSchedulingService>;
  readonly shellExecutor: ReturnType<typeof createMockShellExecutor>;
  readonly subprocessRunner: ReturnType<typeof createMockSubprocessRunner>;
  readonly outputScanner: ReturnType<typeof createMockOutputScanner>;
}

/**
 * Creates a mock OutputScanner that returns predefined OutputFiles.
 *
 * Call tracking: `calls` — array of Locations passed to scan().
 */
function createMockOutputScanner(overrides: {
  readonly files?: readonly OutputFile[];
  readonly throwOnScan?: Error;
} = {}): OutputScanner & {
  readonly calls: Location[];
  setFiles: (files: readonly OutputFile[]) => void;
} {
  let files = overrides.files ?? createStandardOutputFiles();
  const calls: Location[] = [];

  const scanner: OutputScanner = async (
    location: Location,
  ): Promise<readonly OutputFile[]> => {
    calls.push(location);
    if (overrides.throwOnScan) {
      throw overrides.throwOnScan;
    }
    return files;
  };

  return Object.assign(scanner, {
    calls,
    setFiles: (newFiles: readonly OutputFile[]): void => {
      files = newFiles;
    },
  });
}

/**
 * Creates standard output files that a CESM run would produce
 * (matching the feature file scenario).
 */
function createStandardOutputFiles(): readonly OutputFile[] {
  return [
    {
      filename: 'tas_h0_0001-0005.nc',
      format: 'netcdf',
      grid: createMockGrid({ kind: 'lat-lon', nlat: 192, nlon: 288 }),
      variables: [createMockVariable({ name: 'TAS', units: 'K' })],
    },
    {
      filename: 'pr_h0_0001-0005.nc',
      format: 'netcdf',
      grid: createMockGrid({ kind: 'lat-lon', nlat: 192, nlon: 288 }),
      variables: [createMockVariable({ name: 'PR', units: 'mm/day' })],
    },
    {
      filename: 'cas.h0_0001-01.nc',
      format: 'netcdf',
      grid: createMockGrid({ kind: 'lat-lon', nlat: 192, nlon: 288 }),
      variables: [createMockVariable({ name: 'TS', units: 'K' })],
    },
  ];
}

/**
 * Creates a standard CreateCaseInput for testing.
 */
function createStandardCreateInput(overrides: {
  readonly name?: string;
  readonly compset?: string;
  readonly resolution?: string;
  readonly machine?: string;
  readonly runLength?: Duration;
  readonly experimentId?: ExperimentId;
} = {}): {
  readonly name: string;
  readonly compset: string;
  readonly resolution: string;
  readonly machine: string;
  readonly runLength: Duration;
  readonly experimentId: ExperimentId;
} {
  return {
    name: overrides.name ?? 'bhist_f09_g17_001',
    compset: overrides.compset ?? 'BHIST',
    resolution: overrides.resolution ?? 'f09_g17',
    machine: overrides.machine ?? 'daint',
    runLength: overrides.runLength ?? '5 years',
    experimentId:
      overrides.experimentId ?? ('exp-test-001' as ExperimentId),
  };
}

/**
 * Creates a standard CaseConfig for testing.
 */
function createStandardCaseConfig(overrides: {
  readonly runLength?: Duration;
  readonly calendar?: string;
  readonly stopOption?: string;
  readonly customXml?: Record<string, string>;
} = {}): {
  readonly runLength?: Duration;
  readonly calendar?: string;
  readonly stopOption?: string;
  readonly customXml?: Record<string, string>;
} {
  return {
    runLength: overrides.runLength ?? '5 years',
    calendar: overrides.calendar ?? 'noleap',
    stopOption: overrides.stopOption ?? 'nyears',
    customXml: overrides.customXml,
  };
}

/**
 * Creates a CaseService with all mock dependencies.
 *
 * `tools` — Tools to register in the catalog. Default: CESM ModelTool.
 * `shellResult` — default ShellResult from ShellExecutor.
 * `activeEnvironment` — the currently active Environment.
 * `verifyEnvironment` — what verifyEnvironment() returns.
 * `schedulingSubmitResult` — the Job returned by submitJob().
 * `schedulingQueryResult` — function returning a Job for a given
 *   JobId (used by monitorCase).
 * `outputFiles` — files returned by the OutputScanner.
 * `config` — partial override of the default config.
 */
function createCaseService(overrides: {
  readonly tools?: readonly Tool[];
  readonly shellResult?: ReturnType<typeof createMockShellResult>;
  readonly activeEnvironment?: ReturnType<typeof createMockEnvironment> | null;
  readonly verifyEnvironment?: boolean;
  readonly schedulingSubmitResult?: Job;
  readonly schedulingQueryResult?: (jobId: JobId) => Job;
  readonly outputFiles?: readonly OutputFile[];
  readonly outputScannerThrow?: Error;
  readonly config?: Partial<{
    readonly caseOutputBasePath: string;
    readonly pollIntervalMs: number;
    readonly commandTimeoutMs: number;
  }>;
} = {}): CaseServiceSetup {
  const catalog = new ToolCatalogServiceImpl();
  for (const tool of overrides.tools ?? [createMockModelTool()]) {
    void catalog.registerTool(tool);
  }

  const environment = createMockEnvironmentService({
    activeEnvironment:
      overrides.activeEnvironment === undefined
        ? createMockEnvironment({
            uenvSpecs: [
              createMockUenvSpec({ name: 'intel', version: '2021.4' }),
              createMockUenvSpec({ name: 'intel-mpi', version: '2021.4' }),
            ],
          })
        : overrides.activeEnvironment,
    verifyResult: overrides.verifyEnvironment ?? true,
  });

  const dataManagement = createMockDataManagementService();

  const provenance = createMockProvenanceService();

  const scheduling = createMockSchedulingService({
    submitJobResult: overrides.schedulingSubmitResult,
    queryJobResult: overrides.schedulingQueryResult,
  });

  const shellExecutor = createMockShellExecutor({
    defaultResult:
      overrides.shellResult ?? createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 0 }),
      }),
  });

  const subprocessRunner = createMockSubprocessRunner();

  const outputScanner = createMockOutputScanner({
    files: overrides.outputFiles,
    throwOnScan: overrides.outputScannerThrow,
  });

  const props: CaseServiceImplProps = {
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    outputScanner,
    config: overrides.config,
  };

  const service = new CaseServiceImpl(props);

  return {
    service,
    catalog,
    environment,
    dataManagement,
    provenance,
    scheduling,
    shellExecutor,
    subprocessRunner,
    outputScanner,
  };
}

/**
 * Runs the full happy-path lifecycle up to BUILT state.
 * Returns the Case in BUILT state.
 */
async function runLifecycleToBuilt(
  setup: CaseServiceSetup,
  createInput?: Parameters<typeof createStandardCreateInput>[0],
): Promise<Case> {
  const created = await setup.service.createCase(
    createStandardCreateInput(createInput),
  );
  const configured = await setup.service.configureCase(
    created.id,
    createStandardCaseConfig(),
  );
  const built = await setup.service.buildCase(configured.id);
  return built;
}

// ============================================================================
// createCase
// ============================================================================

describe('CaseServiceImpl — createCase', () => {
  it('creates a Case in CREATED state', async () => {
    const { service } = createCaseService();

    const caseEntity = await service.createCase(
      createStandardCreateInput(),
    );

    expect(caseEntity.state).toBe('CREATED');
    expect(caseEntity.name).toBe('bhist_f09_g17_001');
    expect(caseEntity.compset).toBe('BHIST');
    expect(caseEntity.resolution).toBe('f09_g17');
    expect(caseEntity.machine).toBe('daint');
    expect(caseEntity.runLength).toBe('5 years');
    expect(caseEntity.jobId).toBeNull();
  });

  it('sets the output tree Location at creation (INV-T9, R5)', async () => {
    const { service } = createCaseService();

    const caseEntity = await service.createCase(
      createStandardCreateInput(),
    );

    expect(caseEntity.outputTreeLocation).toBeDefined();
    expect(caseEntity.outputTreeLocation.path).toContain(
      'bhist_f09_g17_001',
    );
    expect(caseEntity.outputTreeLocation.path).toContain('/run/');
  });

  it('uses the configured caseOutputBasePath for the output tree', async () => {
    const { service } = createCaseService({
      config: { caseOutputBasePath: '/scratch/snx3000/custom/cases/' },
    });

    const caseEntity = await service.createCase(
      createStandardCreateInput(),
    );

    expect(caseEntity.outputTreeLocation.path).toBe(
      '/scratch/snx3000/custom/cases/bhist_f09_g17_001/run/',
    );
  });

  it('experimentId is accepted without synchronous validation (FINDING-02)', async () => {
    const { service } = createCaseService();

    // A non-existent experimentId is accepted — validation
    // happens asynchronously in agent-interaction (Phase 5).
    const caseEntity = await service.createCase(
      createStandardCreateInput({
        experimentId: 'exp-nonexistent' as ExperimentId,
      }),
    );

    expect(caseEntity.experimentId).toBe('exp-nonexistent');
  });

  it('throws InvalidParameters when compset is empty', async () => {
    const { service } = createCaseService();

    await expect(
      service.createCase(createStandardCreateInput({ compset: '' })),
    ).rejects.toThrow(InvalidParameters);
  });

  it('throws InvalidParameters when resolution is empty', async () => {
    const { service } = createCaseService();

    await expect(
      service.createCase(createStandardCreateInput({ resolution: '' })),
    ).rejects.toThrow(InvalidParameters);
  });

  it('throws InvalidParameters when machine is empty', async () => {
    const { service } = createCaseService();

    await expect(
      service.createCase(createStandardCreateInput({ machine: '' })),
    ).rejects.toThrow(InvalidParameters);
  });

  it('throws InvalidParameters when compset is whitespace-only', async () => {
    const { service } = createCaseService();

    await expect(
      service.createCase(createStandardCreateInput({ compset: '   ' })),
    ).rejects.toThrow(InvalidParameters);
  });
});

// ============================================================================
// INV-T9: Output tree location set at creation and does not change
// ============================================================================

describe('CaseServiceImpl — INV-T9: Output tree location known before submission', () => {
  it('output tree Location does not change across lifecycle steps', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const originalLocation = created.outputTreeLocation;

    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    expect(configured.outputTreeLocation).toEqual(originalLocation);

    const built = await service.buildCase(configured.id);
    expect(built.outputTreeLocation).toEqual(originalLocation);
  });
});

// ============================================================================
// configureCase (FM-M5)
// ============================================================================

describe('CaseServiceImpl — configureCase', () => {
  it('transitions Case from CREATED to CONFIGURED on success', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    expect(configured.state).toBe('CONFIGURED');
  });

  it('executes case.setup via ShellExecutor', async () => {
    const { service, shellExecutor } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    await service.configureCase(created.id, createStandardCaseConfig());

    expect(shellExecutor.calls.length).toBeGreaterThanOrEqual(1);
    expect(shellExecutor.calls[0]?.command).toBe('./case.setup');
  });

  it('writes a ProvenanceRecord for the configure step', async () => {
    const { service, provenance } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    await service.configureCase(created.id, createStandardCaseConfig());

    const configureRecords = provenance.writeCalls.filter(
      (c) => c.caseId === created.id && c.toolName.includes('configure'),
    );
    expect(configureRecords.length).toBeGreaterThanOrEqual(1);
  });

  it('throws NonZeroExitCode and remains CREATED on configure failure (FM-M5)', async () => {
    const { service } = createCaseService({
      shellResult: createMockShellResult({
        exitOutcome: createMockExitOutcome({ code: 1 }),
        stderr: 'Invalid compset INVALID_COMPSET',
      }),
    });

    const created = await service.createCase(
      createStandardCreateInput(),
    );

    await expect(
      service.configureCase(created.id, createStandardCaseConfig()),
    ).rejects.toThrow(NonZeroExitCode);

    // The Case should still be in CREATED state — verify by
    // successfully configuring it with a new service (which has
    // a successful shell result). The original Case is in the
    // original service's internal store.
    //
    // Since we can't access the internal store directly, we verify
    // indirectly: if the Case had transitioned to CONFIGURED,
    // a second configureCase call would throw CaseNotBuilt (wrong
    // state). Instead, a second call with the same failing result
    // throws NonZeroExitCode again — proving the Case is still
    // CREATED (it can be re-configured).
    await expect(
      service.configureCase(created.id, createStandardCaseConfig()),
    ).rejects.toThrow(NonZeroExitCode);
  });

  it('throws CaseNotBuilt when Case is not in CREATED state', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    // Attempting to configure an already-CONFIGURED Case
    await expect(
      service.configureCase(configured.id, createStandardCaseConfig()),
    ).rejects.toThrow(CaseNotBuilt);
  });

  it('throws ToolNotFound when CESM tool is not in catalog', async () => {
    // Empty catalog — no CESM tool
    const { service } = createCaseService({
      tools: [createMockCLITool()],
    });

    const created = await service.createCase(
      createStandardCreateInput(),
    );

    await expect(
      service.configureCase(created.id, createStandardCaseConfig()),
    ).rejects.toThrow(ToolNotFound);
  });
});

// ============================================================================
// buildCase (FM-M1, INV-T1)
// ============================================================================

describe('CaseServiceImpl — buildCase', () => {
  it('transitions Case from CONFIGURED to BUILT on success', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    const built = await service.buildCase(configured.id);

    expect(built.state).toBe('BUILT');
  });

  it('executes case.build via ShellExecutor', async () => {
    const { service, shellExecutor } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    await service.buildCase(configured.id);

    const buildCommands = shellExecutor.calls.filter(
      (c) => c.command === './case.build',
    );
    expect(buildCommands.length).toBe(1);
  });

  it('writes a ProvenanceRecord for the build step', async () => {
    const { service, provenance } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    await service.buildCase(configured.id);

    const buildRecords = provenance.writeCalls.filter(
      (c) => c.toolName.includes('build') && c.caseId === created.id,
    );
    expect(buildRecords.length).toBeGreaterThanOrEqual(1);
  });

  it('throws NonZeroExitCode and remains CONFIGURED on build failure (FM-M1)', async () => {
    // case.setup succeeds (exit 0), case.build fails (exit 2)
    const setupResult = createMockShellResult({
      exitOutcome: createMockExitOutcome({ code: 0 }),
    });
    const buildResult = createMockShellResult({
      exitOutcome: createMockExitOutcome({ code: 2 }),
      stderr: 'Missing dependency: libfoo.so',
    });

    const catalog = new ToolCatalogServiceImpl();
    void catalog.registerTool(createMockModelTool());
    const environment = createMockEnvironmentService({
      activeEnvironment: createMockEnvironment({
        uenvSpecs: [
          createMockUenvSpec({ name: 'intel', version: '2021.4' }),
          createMockUenvSpec({ name: 'intel-mpi', version: '2021.4' }),
        ],
      }),
    });
    const dataManagement = createMockDataManagementService();
    const provenance = createMockProvenanceService();
    const scheduling = createMockSchedulingService();
    const shellExecutor = createMockShellExecutor({
      responses: [
        { match: './case.setup', result: setupResult },
        { match: './case.build', result: buildResult },
      ],
    });
    const subprocessRunner = createMockSubprocessRunner();
    const outputScanner = createMockOutputScanner();

    const service = new CaseServiceImpl({
      catalog,
      environment,
      dataManagement,
      provenance,
      scheduling,
      shellExecutor,
      subprocessRunner,
      outputScanner,
    });

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    await expect(service.buildCase(configured.id)).rejects.toThrow(
      NonZeroExitCode,
    );

    // The Case should still be in CONFIGURED state — a second
    // buildCase attempt should throw NonZeroExitCode again (not a
    // "wrong state" error), proving the Case did NOT transition to
    // BUILT.
    await expect(service.buildCase(configured.id)).rejects.toThrow(
      NonZeroExitCode,
    );
  });

  it('throws EnvironmentNotLoaded when no Environment is active (INV-T1)', async () => {
    const { service } = createCaseService({
      activeEnvironment: null,
    });

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    await expect(service.buildCase(configured.id)).rejects.toThrow(
      EnvironmentNotLoaded,
    );
  });

  it('throws Error when Case is not in CONFIGURED state', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );

    // Attempting to build a Case that is still CREATED (not
    // configured yet).
    await expect(service.buildCase(created.id)).rejects.toThrow(
      'not CONFIGURED',
    );
  });

  it('rejects when verifyEnvironment() returns false', async () => {
    const { service } = createCaseService({
      verifyEnvironment: false,
    });

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    await expect(service.buildCase(configured.id)).rejects.toThrow(
      EnvironmentNotLoaded,
    );
  });
});

// ============================================================================
// submitCase (INV-T6, INV-T7, INV-T8, INV-T9)
// ============================================================================

describe('CaseServiceImpl — submitCase', () => {
  it('transitions Case from BUILT to SUBMITTED and sets jobId (INV-S3)', async () => {
    const mockJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'PENDING',
    });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup);

    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.jobId).toBe(4827365);
  });

  it('writes a ProvenanceRecord for the submission', async () => {
    const mockJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'PENDING',
    });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup);

    await setup.service.submitCase(built.id, createMockResourceRequest());

    const submitRecords = setup.provenance.writeCalls.filter(
      (c) => c.toolName.includes('submit') && c.caseId === built.id,
    );
    expect(submitRecords.length).toBeGreaterThanOrEqual(1);
  });

  it('validates the output tree Location is writable before submission (INV-T9)', async () => {
    const mockJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'PENDING',
    });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup);

    await setup.service.submitCase(built.id, createMockResourceRequest());

    const writeValidations = setup.dataManagement.validateLocationCalls.filter(
      (c) => c.mode === 'write',
    );
    expect(writeValidations.length).toBeGreaterThanOrEqual(1);
  });

  // INV-T6: Submit requires built Case
  it('throws CaseNotBuilt when Case is not in BUILT state (INV-T6)', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    // Case is CONFIGURED, not BUILT
    await expect(
      service.submitCase(configured.id, createMockResourceRequest()),
    ).rejects.toThrow(CaseNotBuilt);
  });

  it('throws CaseNotBuilt when Case is in CREATED state (INV-T6)', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );

    await expect(
      service.submitCase(created.id, createMockResourceRequest()),
    ).rejects.toThrow(CaseNotBuilt);
  });

  // INV-T8: Run length bounded by Wall Time
  it('throws RunLengthExceedsWallTime when run length exceeds wall time (INV-T8)', async () => {
    // 5 years ≈ 43800 hours, wall time = 168 hours → exceeds
    const mockJob = createMockJob({ state: 'PENDING' });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup, {
      runLength: '5 years',
    });

    const shortWallTime: ResourceRequest = {
      ...createMockResourceRequest(),
      wallTime: '168:00:00', // 168 hours
    };

    await expect(
      setup.service.submitCase(built.id, shortWallTime),
    ).rejects.toThrow(RunLengthExceedsWallTimeError);
  });

  it('does NOT throw RunLengthExceedsWallTime when wall time is sufficient (INV-T8)', async () => {
    // 5 years ≈ 43800 hours, wall time = 50000 hours → OK
    const mockJob = createMockJob({ state: 'PENDING' });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup, {
      runLength: '5 years',
    });

    const longWallTime: ResourceRequest = {
      ...createMockResourceRequest(),
      wallTime: '50000:00:00', // 50000 hours
    };

    const submitted = await setup.service.submitCase(
      built.id,
      longWallTime,
    );
    expect(submitted.state).toBe('SUBMITTED');
  });

  // INV-T7: One running Job per Case
  it('throws CaseAlreadyRunning when a Job is already RUNNING (INV-T7)', async () => {
    // First submission succeeds, then the Job is RUNNING.
    // Second submission should be rejected.
    const firstJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'PENDING',
    });
    const runningJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'RUNNING',
      terminalState: null,
    });

    const setup = createCaseService({
      schedulingSubmitResult: firstJob,
      schedulingQueryResult: () => runningJob,
    });
    const built = await runLifecycleToBuilt(setup);

    // First submission succeeds
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );
    expect(submitted.state).toBe('SUBMITTED');

    // Second submission should be rejected because the Job is RUNNING
    await expect(
      setup.service.submitCase(submitted.id, createMockResourceRequest()),
    ).rejects.toThrow(CaseAlreadyRunning);
  });

  it('allows resubmission after the Job reaches a terminal state (INV-T7)', async () => {
    const firstJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'PENDING',
    });
    const completedJob = createMockJob({
      jobId: createJobId(4827365),
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });
    const secondJob = createMockJob({
      jobId: createJobId(4827366),
      state: 'PENDING',
    });

    // First call to submitJob returns firstJob.
    // queryJob returns completedJob (terminal state).
    // Second call to submitJob returns secondJob.
    let submitCallCount = 0;
    const setup = createCaseService({
      schedulingSubmitResult: undefined,
      schedulingQueryResult: () => completedJob,
    });
    // Override submitJob to return different jobs on first vs second call
    setup.scheduling.submitJob = async () => {
      submitCallCount++;
      if (submitCallCount === 1) return firstJob;
      return secondJob;
    };

    const built = await runLifecycleToBuilt(setup);

    // First submission
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );
    expect(submitted.jobId).toBe(4827365);

    // Second submission after the first Job completed — the
    // scheduling mock returns completedJob (terminal state).
    // CaseAlreadyRunning is NOT thrown, because the prior Job
    // has reached a terminal state (COMPLETED).
    const resubmitted = await setup.service.submitCase(
      submitted.id,
      createMockResourceRequest(),
    );
    expect(resubmitted.state).toBe('SUBMITTED');
  });

  it('throws EnvironmentNotLoaded when no Environment is active at submit (INV-T1)', async () => {
    const mockJob = createMockJob({ state: 'PENDING' });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup);

    // Remove the active Environment
    setup.environment.setActiveEnvironment(null);

    await expect(
      setup.service.submitCase(built.id, createMockResourceRequest()),
    ).rejects.toThrow(EnvironmentNotLoaded);
  });

  it('calls verifyEnvironment() immediately before submit', async () => {
    const mockJob = createMockJob({ state: 'PENDING' });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup);

    // Reset verify calls from the build phase
    setup.environment.verifyCalls.length = 0;

    await setup.service.submitCase(built.id, createMockResourceRequest());

    expect(setup.environment.verifyCalls.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// monitorCase (INV-S4, FM-M2, FM-M3, FM-M4)
// ============================================================================

describe('CaseServiceImpl — monitorCase', () => {
  it('emits CaseState changes as the Job progresses', async () => {
    // Simulate: PENDING → RUNNING → COMPLETED
    const states: JobState[] = ['PENDING', 'RUNNING', 'COMPLETED'];
    let pollIndex = 0;
    const jobId = createJobId(4827365);

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'COMPLETED';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'COMPLETED' ? 'COMPLETED' : null,
        });
      },
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);

    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });

    // Wait for polling to complete
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    unsubscribe();

    // Should have emitted SUBMITTED (PENDING), RUNNING, COMPLETED
    expect(emittedStates).toContain('RUNNING');
    expect(emittedStates).toContain('COMPLETED');
  });

  it('emits FAILED when Job reaches FAILED state (FM-M2)', async () => {
    // Simulate: PENDING → RUNNING → FAILED
    const states: JobState[] = ['PENDING', 'RUNNING', 'FAILED'];
    let pollIndex = 0;
    const jobId = createJobId(4827366);

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'FAILED';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'FAILED' ? ('FAILED' as JobState) : null,
        });
      },
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);

    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    expect(emittedStates).toContain('FAILED');
  });

  it('emits FAILED when Job reaches TIMEOUT state (FM-M3)', async () => {
    // Simulate: PENDING → RUNNING → TIMEOUT
    const states: JobState[] = ['PENDING', 'RUNNING', 'TIMEOUT'];
    let pollIndex = 0;
    const jobId = createJobId(4827367);

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'TIMEOUT';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'TIMEOUT' ? ('TIMEOUT' as JobState) : null,
        });
      },
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);

    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    // TIMEOUT maps to FAILED in CaseState
    expect(emittedStates).toContain('FAILED');
  });

  it('emits FAILED when Job reaches NODE_FAIL state (FM-M4)', async () => {
    // Simulate: PENDING → RUNNING → NODE_FAIL
    const states: JobState[] = ['PENDING', 'RUNNING', 'NODE_FAIL'];
    let pollIndex = 0;
    const jobId = createJobId(4827368);

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'NODE_FAIL';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'NODE_FAIL' ? ('NODE_FAIL' as JobState) : null,
        });
      },
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);

    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    // NODE_FAIL maps to FAILED in CaseState
    expect(emittedStates).toContain('FAILED');
  });

  it('stops emitting once a terminal state is reached (INV-S4)', async () => {
    // Simulate: PENDING → COMPLETED (then stop)
    const states: JobState[] = ['PENDING', 'COMPLETED'];
    let pollIndex = 0;
    const jobId = createJobId(4827370);

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'COMPLETED';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'COMPLETED' ? 'COMPLETED' : null,
        });
      },
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);

    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const countAfterTerminal = emittedStates.length;

    // Wait a bit more — no new events should be emitted
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    unsubscribe();

    expect(emittedStates.length).toBe(countAfterTerminal);
  });

  it('returns an empty observable for a Case without a Job', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );

    const observable = service.monitorCase(created.id);
    expect(observable).toBeDefined();

    // Should not emit any events (no Job to monitor)
    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    unsubscribe();
    expect(emittedStates.length).toBe(0);
  });
});

// ============================================================================
// registerCaseOutput (post-process)
// ============================================================================

describe('CaseServiceImpl — registerCaseOutput', () => {
  it('registers Datasets after the Job reaches COMPLETED', async () => {
    const jobId = createJobId(4827365);
    const completedJob = createMockJob({
      jobId,
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => completedJob,
      outputFiles: createStandardOutputFiles(),
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    // Monitor until COMPLETED to update the Case state
    const observable = setup.service.monitorCase(submitted.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    // Now register the output
    const datasets = await setup.service.registerCaseOutput(
      submitted.id,
    );

    expect(datasets.length).toBe(3);
    expect(datasets[0]?.name).toBe('tas_h0_0001-0005');
    expect(datasets[1]?.name).toBe('pr_h0_0001-0005');
    expect(datasets[2]?.name).toBe('cas.h0_0001-01');
  });

  it('writes a ProvenanceRecord for each output Dataset', async () => {
    const jobId = createJobId(4827365);
    const completedJob = createMockJob({
      jobId,
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => completedJob,
      outputFiles: createStandardOutputFiles(),
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    // Clear provenance calls from the lifecycle steps
    setup.provenance.writeCalls.length = 0;

    await setup.service.registerCaseOutput(submitted.id);

    // Should have written one ProvenanceRecord per Dataset
    const outputRecords = setup.provenance.writeCalls.filter(
      (c) => c.outputDatasetId !== null,
    );
    expect(outputRecords.length).toBe(3);
  });

  it('marks each output Dataset as consumable (INV-D3)', async () => {
    const jobId = createJobId(4827365);
    const completedJob = createMockJob({
      jobId,
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => completedJob,
      outputFiles: createStandardOutputFiles(),
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    await setup.service.registerCaseOutput(submitted.id);

    // Should have called markConsumable for each Dataset
    expect(setup.dataManagement.markConsumableCalls.length).toBe(3);
  });

  it('throws Error when Case is not in COMPLETED state', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    // Case is in CONFIGURED, not COMPLETED
    await expect(
      service.registerCaseOutput(configured.id),
    ).rejects.toThrow('not COMPLETED');
  });

  it('throws Error when the output tree is empty', async () => {
    const jobId = createJobId(4827365);
    const completedJob = createMockJob({
      jobId,
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => completedJob,
      outputFiles: [], // empty output
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    await expect(
      setup.service.registerCaseOutput(submitted.id),
    ).rejects.toThrow('empty');
  });

  it('throws Error when the output tree is inaccessible', async () => {
    const jobId = createJobId(4827365);
    const completedJob = createMockJob({
      jobId,
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => completedJob,
      outputScannerThrow: new Error('Permission denied'),
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    await expect(
      setup.service.registerCaseOutput(submitted.id),
    ).rejects.toThrow('inaccessible');
  });
});

// ============================================================================
// Full lifecycle (happy path)
// ============================================================================

describe('CaseServiceImpl — full lifecycle (happy path)', () => {
  it('create → configure → build → submit → monitor → registerCaseOutput', async () => {
    const jobId = createJobId(4827365);
    const states: JobState[] = ['PENDING', 'RUNNING', 'COMPLETED'];
    let pollIndex = 0;

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'COMPLETED';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'COMPLETED' ? 'COMPLETED' : null,
        });
      },
      outputFiles: createStandardOutputFiles(),
      config: { pollIntervalMs: 1 },
    });

    // 1. Create
    const created = await setup.service.createCase(
      createStandardCreateInput(),
    );
    expect(created.state).toBe('CREATED');

    // 2. Configure
    const configured = await setup.service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    expect(configured.state).toBe('CONFIGURED');

    // 3. Build
    const built = await setup.service.buildCase(configured.id);
    expect(built.state).toBe('BUILT');

    // 4. Submit
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );
    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.jobId).toBe(4827365);

    // 5. Monitor
    const observable = setup.service.monitorCase(submitted.id);
    const emittedStates: CaseState[] = [];
    const unsubscribe = observable.subscribe((state) => {
      emittedStates.push(state);
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    expect(emittedStates).toContain('RUNNING');
    expect(emittedStates).toContain('COMPLETED');

    // 6. Register output
    const datasets = await setup.service.registerCaseOutput(
      submitted.id,
    );
    expect(datasets.length).toBe(3);
  });

  it('writes ProvenanceRecords for all lifecycle steps', async () => {
    const jobId = createJobId(4827365);
    const completedJob = createMockJob({
      jobId,
      state: 'COMPLETED',
      terminalState: 'COMPLETED',
    });

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => completedJob,
      outputFiles: createStandardOutputFiles(),
      config: { pollIntervalMs: 1 },
    });

    const created = await setup.service.createCase(
      createStandardCreateInput(),
    );
    await setup.service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    await setup.service.buildCase(created.id);
    await setup.service.submitCase(created.id, createMockResourceRequest());

    const observable = setup.service.monitorCase(created.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    await setup.service.registerCaseOutput(created.id);

    // Should have ProvenanceRecords for: configure, build, submit,
    // and one per output Dataset (3)
    const caseRecords = setup.provenance.writeCalls.filter(
      (c) => c.caseId === created.id,
    );
    // configure (1) + build (1) + submit (1) + output (3) = 6
    expect(caseRecords.length).toBeGreaterThanOrEqual(6);
  });
});

// ============================================================================
// Case state transitions
// ============================================================================

describe('CaseServiceImpl — Case state transitions', () => {
  it('created Case is in CREATED state', async () => {
    const { service } = createCaseService();

    const caseEntity = await service.createCase(
      createStandardCreateInput(),
    );

    expect(caseEntity.state).toBe('CREATED');
  });

  it('configured Case is in CONFIGURED state', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );

    expect(configured.state).toBe('CONFIGURED');
  });

  it('built Case is in BUILT state', async () => {
    const { service } = createCaseService();

    const created = await service.createCase(
      createStandardCreateInput(),
    );
    const configured = await service.configureCase(
      created.id,
      createStandardCaseConfig(),
    );
    const built = await service.buildCase(configured.id);

    expect(built.state).toBe('BUILT');
  });

  it('submitted Case is in SUBMITTED state with jobId set', async () => {
    const mockJob = createMockJob({
      jobId: createJobId(42),
      state: 'PENDING',
    });
    const setup = createCaseService({
      schedulingSubmitResult: mockJob,
    });
    const built = await runLifecycleToBuilt(setup);

    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    expect(submitted.state).toBe('SUBMITTED');
    expect(submitted.jobId).toBe(42);
  });

  it('Case reaches COMPLETED after Job completes (via monitorCase)', async () => {
    const jobId = createJobId(4827365);
    const states: JobState[] = ['PENDING', 'RUNNING', 'COMPLETED'];
    let pollIndex = 0;

    const setup = createCaseService({
      schedulingSubmitResult: createMockJob({ jobId, state: 'PENDING' }),
      schedulingQueryResult: () => {
        const state = states[pollIndex] ?? 'COMPLETED';
        pollIndex++;
        return createMockJob({
          jobId,
          state,
          terminalState:
            state === 'COMPLETED' ? 'COMPLETED' : null,
        });
      },
      config: { pollIntervalMs: 1 },
    });

    const built = await runLifecycleToBuilt(setup);
    const submitted = await setup.service.submitCase(
      built.id,
      createMockResourceRequest(),
    );

    const observable = setup.service.monitorCase(submitted.id);
    const unsubscribe = observable.subscribe(() => {});
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    unsubscribe();

    // After monitoring, the Case should be in COMPLETED state.
    // We verify by calling registerCaseOutput — it only works
    // when the Case is COMPLETED.
    const datasets = await setup.service.registerCaseOutput(
      submitted.id,
    );
    expect(datasets.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// runLengthExceedsWallTime helper (INV-T8)
// ============================================================================

describe('runLengthExceedsWallTime helper (INV-T8)', () => {
  it('returns true when run length (years) exceeds wall time', () => {
    // 5 years ≈ 43800 hours > 168 hours
    expect(runLengthExceedsWallTime('5 years' as Duration, '168:00:00')).toBe(
      true,
    );
  });

  it('returns false when run length (years) fits within wall time', () => {
    // 5 years ≈ 43800 hours < 50000 hours
    expect(
      runLengthExceedsWallTime('5 years' as Duration, '50000:00:00'),
    ).toBe(false);
  });

  it('returns true when run length (days) exceeds wall time', () => {
    // 100 days = 2400 hours > 168 hours
    expect(
      runLengthExceedsWallTime('100 days' as Duration, '168:00:00'),
    ).toBe(true);
  });

  it('returns false when run length (days) fits within wall time', () => {
    // 5 days = 120 hours < 168 hours
    expect(
      runLengthExceedsWallTime('5 days' as Duration, '168:00:00'),
    ).toBe(false);
  });

  it('returns false when run length (hours) fits within wall time', () => {
    expect(
      runLengthExceedsWallTime('100 hours' as Duration, '168:00:00'),
    ).toBe(false);
  });

  it('returns true when run length (hours) exceeds wall time', () => {
    expect(
      runLengthExceedsWallTime('200 hours' as Duration, '168:00:00'),
    ).toBe(true);
  });

  it('returns false (allows submission) for unknown unit', () => {
    expect(
      runLengthExceedsWallTime('5 eternities' as Duration, '168:00:00'),
    ).toBe(false);
  });

  it('returns false (allows submission) for malformed run length', () => {
    expect(
      runLengthExceedsWallTime('not-a-duration' as Duration, '168:00:00'),
    ).toBe(false);
  });

  it('returns false (allows submission) for malformed wall time', () => {
    expect(
      runLengthExceedsWallTime('5 years' as Duration, 'not-a-walltime'),
    ).toBe(false);
  });

  it('handles singular unit "year"', () => {
    // 1 year = 8760 hours > 168 hours
    expect(
      runLengthExceedsWallTime('1 year' as Duration, '168:00:00'),
    ).toBe(true);
  });

  it('handles singular unit "day"', () => {
    // 1 day = 24 hours < 168 hours
    expect(
      runLengthExceedsWallTime('1 day' as Duration, '168:00:00'),
    ).toBe(false);
  });

  it('handles singular unit "hour"', () => {
    // 1 hour < 168 hours
    expect(
      runLengthExceedsWallTime('1 hour' as Duration, '168:00:00'),
    ).toBe(false);
  });
});

// ============================================================================
// Module exports
// ============================================================================

describe('tool-invocation module exports', () => {
  it('exports CLIExecutorImpl, PythonExecutorImpl, CaseServiceImpl, ToolCatalogServiceImpl, ToolInvocationServiceImpl', async () => {
    const mod = await import('../../src/tool-invocation/index');
    expect(mod.CLIExecutorImpl).toBeDefined();
    expect(mod.PythonExecutorImpl).toBeDefined();
    expect(mod.CaseServiceImpl).toBeDefined();
    expect(mod.ToolCatalogServiceImpl).toBeDefined();
    expect(mod.ToolInvocationServiceImpl).toBeDefined();
  });

  it('exports runLengthExceedsWallTime', async () => {
    const mod = await import('../../src/tool-invocation/index');
    expect(typeof mod.runLengthExceedsWallTime).toBe('function');
  });
});
