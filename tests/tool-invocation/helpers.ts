/**
 * Test helpers for the tool-invocation module.
 *
 * Provides mock factories for ALL dependencies (ShellExecutor,
 * SubprocessRunner, SandboxRunner, SchedulingService,
 * EnvironmentService, ProvenanceService, DataManagementService,
 * JobMonitor) plus Tool, ToolInvocation, and Case data factories so
 * tests can verify all nine invariants (INV-T1–T9) and all ten
 * failure modes (FM-T1–T5, FM-M1–M5) without real HPC services.
 *
 * Spec: build-phases.md Phase 4 (Tier 1 — unit tests with all mocked
 * deps).
 */

import type {
  ShellExecutor,
  ShellResult,
  SubprocessRunner,
  SubprocessOptions,
  SandboxRunner,
  SandboxOptions,
  SubprocessHandle,
} from '../../src/dsh-adapter/types';
import type {
  SchedulingService,
  SubmitJobInput,
  JobMonitor,
} from '../../src/scheduling/types';
import type { EnvironmentService } from '../../src/environment-management/types';
import type { ProvenanceService } from '../../src/provenance/types';
import type {
  DataManagementService,
  RegisterDatasetInput,
} from '../../src/data-management/types';
import type {
  AsyncObservable,
  Case,
  CaseId,
  CaseState,
  CLITool,
  Compset,
  Dataset,
  DatasetId,
  Duration,
  Environment,
  EnvironmentId,
  ExitOutcome,
  Format,
  Grid,
  Job,
  JobId,
  JobState,
  Location,
  ModelTool,
  ProvenanceRecord,
  ProvenanceRecordId,
  PythonTool,
  ResourceRequest,
  ToolId,
  ToolInvocation,
  ToolInvocationId,
  UenvSpec,
  Variable,
} from '../../src/types';

// ============================================================================
// Branded ID factories
// ============================================================================

export function createToolId(id: string): ToolId {
  return id as ToolId;
}

export function createToolInvocationId(id: string): ToolInvocationId {
  return id as ToolInvocationId;
}

export function createCaseId(id: string): CaseId {
  return id as CaseId;
}

export function createDatasetId(id: string): DatasetId {
  return id as DatasetId;
}

export function createEnvironmentId(id: string): EnvironmentId {
  return id as EnvironmentId;
}

export function createJobId(n: number): JobId {
  return n as JobId;
}

export function createProvenanceRecordId(id: string): ProvenanceRecordId {
  return id as ProvenanceRecordId;
}

// ============================================================================
// Value object factories
// ============================================================================

export function createMockLocation(overrides: Partial<Location> = {}): Location {
  return {
    path: overrides.path ?? '/scratch/snx3000/cera_user/data/test.nc',
    filesystem: overrides.filesystem ?? 'scratch',
  };
}

export function createMockExitOutcome(overrides: Partial<ExitOutcome> = {}): ExitOutcome {
  return {
    kind: 'exit_code',
    code: 0,
    ...overrides,
  } as ExitOutcome;
}

export function createMockGrid(overrides: Partial<Grid> & { kind?: Grid['kind'] } = {}): Grid {
  const kind = overrides.kind ?? 'lat-lon';
  if (kind === 'lat-lon') {
    return {
      kind: 'lat-lon',
      nlat: (overrides as { nlat?: number }).nlat ?? 90,
      nlon: (overrides as { nlon?: number }).nlon ?? 180,
    };
  }
  if (kind === 'icon') {
    return {
      kind: 'icon',
      refinementLevel: (overrides as { refinementLevel?: string }).refinementLevel ?? 'R02B09',
    };
  }
  if (kind === 'healpix') {
    return {
      kind: 'healpix',
      nside: (overrides as { nside?: number }).nside ?? 1024,
      nest: (overrides as { nest?: boolean }).nest ?? true,
    };
  }
  return {
    kind: 'grib2-native',
    spectral: (overrides as { spectral?: string }).spectral ?? 'T1279',
  };
}

export function createMockVariable(overrides: Partial<Variable> = {}): Variable {
  return {
    name: overrides.name ?? 'TAS',
    units: overrides.units ?? 'K',
    dimensions: overrides.dimensions ?? ['time', 'lat', 'lon'],
  };
}

export function createMockResourceRequest(overrides: Partial<ResourceRequest> = {}): ResourceRequest {
  return {
    nodes: overrides.nodes ?? 1,
    coresPerNode: overrides.coresPerNode ?? 36,
    memory: overrides.memory ?? '128GB',
    wallTime: overrides.wallTime ?? '50000:00:00',
    partition: overrides.partition ?? 'normal',
    qos: overrides.qos ?? 'default',
  };
}

export function createMockUenvSpec(overrides: Partial<UenvSpec> = {}): UenvSpec {
  return {
    name: overrides.name ?? 'cdo',
    version: overrides.version ?? '2.0.5',
    mountPath: overrides.mountPath ?? '/user-environment/env/cdo/2.0.5',
  };
}

// ============================================================================
// ShellResult factory
// ============================================================================

export function createMockShellResult(overrides: Partial<ShellResult> = {}): ShellResult {
  return {
    stdout: overrides.stdout ?? '',
    stderr: overrides.stderr ?? '',
    exitOutcome: overrides.exitOutcome ?? createMockExitOutcome(),
  };
}

// ============================================================================
// Mock ShellExecutor
// ============================================================================

/**
 * A configurable mock ShellExecutor. Each call to execute() looks
 * up the response based on a match function.
 *
 * Call tracking: `calls` — array of { command, options } passed to
 * execute().
 */
export function createMockShellExecutor(overrides: {
  readonly responses?: ReadonlyArray<{
    readonly match: string;
    readonly result: ShellResult;
  }>;
  readonly defaultResult?: ShellResult;
  readonly throwOnExecute?: Error;
} = {}): ShellExecutor & {
  readonly calls: { command: string }[];
} {
  const responses = overrides.responses ?? [];
  const defaultResult = overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string }[] = [];

  const findResponse = (command: string): ShellResult => {
    for (const r of responses) {
      if (command.includes(r.match)) {
        return r.result;
      }
    }
    return defaultResult;
  };

  const executor: ShellExecutor = {
    async execute(command: string, _options?: { cwd?: string; env?: Record<string, string>; timeout?: number; stdin?: string }): Promise<ShellResult> {
      calls.push({ command });
      if (overrides.throwOnExecute) {
        throw overrides.throwOnExecute;
      }
      return findResponse(command);
    },
  };

  return {
    ...executor,
    calls,
  };
}

// ============================================================================
// Mock SubprocessRunner
// ============================================================================

/**
 * A configurable mock SubprocessRunner. Each call to execute() looks
 * up the response based on the command and (optionally) args.
 *
 * Call tracking: `calls` — array of { command, args } passed to
 * execute() or spawn().
 */
export function createMockSubprocessRunner(overrides: {
  readonly responses?: ReadonlyArray<{
    readonly match: string;
    readonly result: ShellResult;
    readonly exact?: boolean;
  }>;
  readonly defaultResult?: ShellResult;
  readonly throwOnExecute?: Error;
} = {}): SubprocessRunner & {
  readonly calls: { command: string; args: readonly string[] }[];
} {
  const responses = overrides.responses ?? [];
  const defaultResult = overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string; args: readonly string[] }[] = [];

  const findResponse = (command: string): ShellResult => {
    for (const r of responses) {
      const match = r.exact
        ? command === r.match
        : command.startsWith(r.match);
      if (match) {
        return r.result;
      }
    }
    return defaultResult;
  };

  const runner: SubprocessRunner = {
    async execute(command: string, args: string[], _options?: SubprocessOptions): Promise<ShellResult> {
      calls.push({ command, args });
      if (overrides.throwOnExecute) {
        throw overrides.throwOnExecute;
      }
      return findResponse(command);
    },
    spawn(_command: string, _args: string[], _options?: SubprocessOptions): SubprocessHandle {
      throw new Error('spawn not implemented in mock');
    },
  };

  return {
    ...runner,
    calls,
  };
}

// ============================================================================
// Mock SandboxRunner
// ============================================================================

export function createMockSandboxRunner(overrides: {
  readonly defaultResult?: ShellResult;
} = {}): SandboxRunner & {
  readonly calls: { command: string }[];
} {
  const defaultResult = overrides.defaultResult ?? createMockShellResult();
  const calls: { command: string }[] = [];

  const runner: SandboxRunner = {
    async execute(command: string, _options?: SandboxOptions): Promise<ShellResult> {
      calls.push({ command });
      return defaultResult;
    },
    spawn(_command: string, _args: string[], _options?: SandboxOptions): SubprocessHandle {
      throw new Error('spawn not implemented in mock');
    },
  };

  return {
    ...runner,
    calls,
  };
}

// ============================================================================
// Mock SchedulingService
// ============================================================================

/**
 * A configurable mock SchedulingService.
 *
 * `submitJobResult` — the Job to return from submitJob(). Default:
 * a RUNNING Job with JobId 4827365.
 * `queryJobResult` — a function that returns a Job for a given
 * JobId, or a default Job.
 * `submitJobError` — if set, submitJob() throws this error.
 *
 * Call tracking: `submitCalls`, `queryCalls`, `cancelCalls`.
 */
export function createMockSchedulingService(overrides: {
  readonly submitJobResult?: Job;
  readonly queryJobResult?: (jobId: JobId) => Job;
  readonly submitJobError?: Error;
  readonly queryJobsByUserResult?: Job[];
} = {}): SchedulingService & {
  readonly submitCalls: SubmitJobInput[];
  readonly queryCalls: JobId[];
  readonly cancelCalls: JobId[];
  setQueryJobResult: (fn: (jobId: JobId) => Job) => void;
} {
  const submitCalls: SubmitJobInput[] = [];
  const queryCalls: JobId[] = [];
  const cancelCalls: JobId[] = [];
  let queryFn = overrides.queryJobResult ?? ((_jobId: JobId): Job => {
    return overrides.submitJobResult ?? createMockJob({ state: 'RUNNING' });
  });

  const service: SchedulingService = {
    async submitJob(request: SubmitJobInput): Promise<Job> {
      submitCalls.push(request);
      if (overrides.submitJobError) {
        throw overrides.submitJobError;
      }
      return overrides.submitJobResult ?? createMockJob({ state: 'PENDING' });
    },
    async queryJob(jobId: JobId): Promise<Job> {
      queryCalls.push(jobId);
      return queryFn(jobId);
    },
    async queryJobsByUser(_username: string): Promise<Job[]> {
      return overrides.queryJobsByUserResult ?? [];
    },
    async cancelJob(jobId: JobId): Promise<void> {
      cancelCalls.push(jobId);
    },
    async reconcileViaSacct(_jobIds: JobId[]): Promise<Job[]> {
      return [];
    },
  };

  return {
    ...service,
    submitCalls,
    queryCalls,
    cancelCalls,
    setQueryJobResult: (fn: (jobId: JobId) => Job) => {
      queryFn = fn;
    },
  };
}

// ============================================================================
// Mock JobMonitor
// ============================================================================

/**
 * A mock JobMonitor that emits a predefined sequence of JobEvents.
 */
export function createMockJobMonitor(overrides: {
  readonly events?: readonly import('../../src/types').JobEvent[];
} = {}): JobMonitor & {
  readonly watchCalls: JobId[];
} {
  const events = overrides.events ?? [];
  const watchCalls: JobId[] = [];

  const monitor: JobMonitor = {
    watch(jobId: JobId): AsyncObservable<import('../../src/types').JobEvent> {
      watchCalls.push(jobId);
      return createMockAsyncObservable(events);
    },
  };

  return {
    ...monitor,
    watchCalls,
  };
}

// ============================================================================
// Mock EnvironmentService
// ============================================================================

/**
 * A configurable mock EnvironmentService.
 *
 * `activeEnvironment` — the currently active Environment, or null.
 * `verifyResult` — what verifyEnvironment() returns. Default: true.
 * `verifyError` — if set, verifyEnvironment() throws this error.
 *
 * Call tracking: `verifyCalls`, `loadCalls`.
 */
export function createMockEnvironmentService(overrides: {
  readonly activeEnvironment?: Environment | null;
  readonly verifyResult?: boolean;
  readonly verifyError?: Error;
} = {}): EnvironmentService & {
  readonly verifyCalls: EnvironmentId[];
  readonly loadCalls: import('../../src/environment-management/types').LoadUenvInput[];
  setActiveEnvironment: (env: Environment | null) => void;
} {
  const verifyCalls: EnvironmentId[] = [];
  const loadCalls: import('../../src/environment-management/types').LoadUenvInput[] = [];
  let activeEnv = overrides.activeEnvironment === undefined
    ? createMockEnvironment()
    : overrides.activeEnvironment;

  const service: EnvironmentService = {
    async checkUenvAvailability(_name: string, _version: string): Promise<boolean> {
      return true;
    },
    async loadUenv(request: import('../../src/environment-management/types').LoadUenvInput): Promise<Environment> {
      loadCalls.push(request);
      return activeEnv ?? createMockEnvironment();
    },
    async unloadUenv(_environmentId: EnvironmentId): Promise<void> {
      activeEnv = null;
    },
    async verifyEnvironment(environmentId: EnvironmentId): Promise<boolean> {
      verifyCalls.push(environmentId);
      if (overrides.verifyError) {
        throw overrides.verifyError;
      }
      return overrides.verifyResult ?? true;
    },
    async detectConflicts(_uenvSpecs: UenvSpec[]): Promise<import('../../src/types').Conflict[]> {
      return [];
    },
    getActiveEnvironment(): Environment | null {
      return activeEnv;
    },
  };

  return {
    ...service,
    verifyCalls,
    loadCalls,
    setActiveEnvironment: (env: Environment | null) => {
      activeEnv = env;
    },
  };
}

// ============================================================================
// Mock ProvenanceService
// ============================================================================

/**
 * A configurable mock ProvenanceService.
 *
 * `writeResult` — the ProvenanceRecord to return from
 * writeProvenanceRecord(). Default: a mock record.
 * `writeError` — if set, writeProvenanceRecord() throws this error.
 * `verifyResult` — what verifyProvenance() returns. Default: true.
 *
 * Call tracking: `writeCalls`, `verifyCalls`, `quarantineCalls`.
 */
export function createMockProvenanceService(overrides: {
  readonly writeResult?: ProvenanceRecord;
  readonly writeError?: Error;
  readonly verifyResult?: boolean;
  readonly queryResult?: ProvenanceRecord | null;
} = {}): ProvenanceService & {
  readonly writeCalls: import('../../src/provenance/types').WriteProvenanceInput[];
  readonly verifyCalls: DatasetId[];
  readonly quarantineCalls: { readonly datasetId: DatasetId; readonly reason: string }[];
  setVerifyResult: (result: boolean) => void;
} {
  const writeCalls: import('../../src/provenance/types').WriteProvenanceInput[] = [];
  const verifyCalls: DatasetId[] = [];
  const quarantineCalls: { datasetId: DatasetId; reason: string }[] = [];
  let verifyRes = overrides.verifyResult ?? true;

  const service: ProvenanceService = {
    async writeProvenanceRecord(
      input: import('../../src/provenance/types').WriteProvenanceInput,
    ): Promise<ProvenanceRecord> {
      writeCalls.push(input);
      if (overrides.writeError) {
        throw overrides.writeError;
      }
      return (
        overrides.writeResult ?? createMockProvenanceRecord({
          toolId: input.toolId,
          toolName: input.toolName,
          toolVersion: input.toolVersion,
          parameters: input.parameters,
          environmentId: input.environmentId,
          environmentDescription: input.environmentDescription,
          inputDatasetIds: input.inputDatasetIds,
          outputDatasetId: input.outputDatasetId,
          exitOutcome: input.exitOutcome,
          timestamp: input.timestamp,
          jobId: input.jobId,
          jobState: input.jobState,
          caseId: input.caseId,
        })
      );
    },
    async queryProvenanceRecord(_datasetId: DatasetId): Promise<ProvenanceRecord | null> {
      return overrides.queryResult ?? null;
    },
    async queryProvenanceForJob(_jobId: JobId): Promise<ProvenanceRecord | null> {
      return null;
    },
    async queryLineage(_datasetId: DatasetId): Promise<ProvenanceRecord[]> {
      return [];
    },
    async verifyProvenance(datasetId: DatasetId): Promise<boolean> {
      verifyCalls.push(datasetId);
      return verifyRes;
    },
    async reconstructProvenanceRecord(
      _input: import('../../src/provenance/types').ReconstructInput,
    ): Promise<ProvenanceRecord | null> {
      return null;
    },
    async quarantineDataset(datasetId: DatasetId, reason: string): Promise<void> {
      quarantineCalls.push({ datasetId, reason });
    },
  };

  return {
    ...service,
    writeCalls,
    verifyCalls,
    quarantineCalls,
    setVerifyResult: (result: boolean) => {
      verifyRes = result;
    },
  };
}

// ============================================================================
// Mock DataManagementService
// ============================================================================

/**
 * A configurable mock DataManagementService.
 *
 * `datasets` — a Map of DatasetId → Dataset. queryDataset() and
 * listDatasets() use this map. registerDataset() adds to it.
 * `validateLocationResult` — what validateLocation() returns.
 * `validateLocationError` — if set, validateLocation() throws this.
 * `markConsumableError` — if set, markConsumable() throws this.
 *
 * Call tracking: `registerCalls`, `validateLocationCalls`,
 * `markConsumableCalls`.
 */
export function createMockDataManagementService(overrides: {
  readonly datasets?: ReadonlyMap<DatasetId, Dataset>;
  readonly validateLocationResult?: boolean;
  readonly validateLocationError?: Error;
  readonly markConsumableError?: Error;
} = {}): DataManagementService & {
  readonly registerCalls: RegisterDatasetInput[];
  readonly validateLocationCalls: { readonly location: Location; readonly mode: 'read' | 'write' }[];
  readonly markConsumableCalls: DatasetId[];
  readonly quarantineCalls: { readonly datasetId: DatasetId; readonly reason: string }[];
  readonly store: Map<DatasetId, Dataset>;
  setDataset: (dataset: Dataset) => void;
} {
  const store = new Map<DatasetId, Dataset>(
    overrides.datasets ? Array.from(overrides.datasets) : [],
  );
  const registerCalls: RegisterDatasetInput[] = [];
  const validateLocationCalls: { location: Location; mode: 'read' | 'write' }[] = [];
  const markConsumableCalls: DatasetId[] = [];
  const quarantineCalls: { datasetId: DatasetId; reason: string }[] = [];

  const service: DataManagementService = {
    async registerDataset(input: RegisterDatasetInput): Promise<Dataset> {
      registerCalls.push(input);
      const dataset: Dataset = Object.freeze({
        id: createDatasetId(`ds-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        name: input.name,
        location: input.location,
        format: input.format,
        grid: input.grid,
        variables: input.variables,
        producerToolInvocationId: input.producerToolInvocationId ?? null,
        consumable: false,
        quarantined: false,
        createdAt: new Date(),
      });
      store.set(dataset.id, dataset);
      return dataset;
    },
    async queryDataset(id: DatasetId): Promise<Dataset | null> {
      return store.get(id) ?? null;
    },
    async listDatasets(_filter?: import('../../src/data-management/types').DatasetFilter): Promise<Dataset[]> {
      return Array.from(store.values());
    },
    async validateLocation(location: Location, mode: 'read' | 'write'): Promise<boolean> {
      validateLocationCalls.push({ location, mode });
      if (overrides.validateLocationError) {
        throw overrides.validateLocationError;
      }
      return overrides.validateLocationResult ?? true;
    },
    async markConsumable(datasetId: DatasetId): Promise<void> {
      markConsumableCalls.push(datasetId);
      if (overrides.markConsumableError) {
        throw overrides.markConsumableError;
      }
      const existing = store.get(datasetId);
      if (existing !== undefined) {
        store.set(datasetId, Object.freeze({ ...existing, consumable: true }));
      }
    },
    async quarantineDataset(datasetId: DatasetId, reason: string): Promise<void> {
      quarantineCalls.push({ datasetId, reason });
      const existing = store.get(datasetId);
      if (existing !== undefined) {
        store.set(datasetId, Object.freeze({ ...existing, quarantined: true, consumable: false }));
      }
    },
  };

  return {
    ...service,
    registerCalls,
    validateLocationCalls,
    markConsumableCalls,
    quarantineCalls,
    store,
    setDataset: (dataset: Dataset) => {
      store.set(dataset.id, dataset);
    },
  };
}

// ============================================================================
// Mock AsyncObservable
// ============================================================================

/**
 * Creates a mock AsyncObservable that emits a predefined sequence of
 * events. Once all events are emitted, the observable completes.
 *
 * Supports subscribe(), [Symbol.asyncIterator](), and cancel().
 */
export function createMockAsyncObservable<T>(events: readonly T[]): AsyncObservable<T> & {
  readonly cancelled: boolean;
  readonly subscribers: Array<(event: T) => void>;
} {
  let cancelled = false;
  const subscribers: Array<(event: T) => void> = [];

  const emitAll = (): void => {
    for (const event of events) {
      if (cancelled) break;
      for (const sub of subscribers) {
        sub(event);
      }
    }
  };

  // Emit on next tick to allow subscription
  setTimeout(emitAll, 0);

  const observable: AsyncObservable<T> = {
    [Symbol.asyncIterator](): AsyncIterator<T> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<T>> {
          if (cancelled || index >= events.length) {
            return { done: true, value: undefined as T };
          }
          const value = events[index];
          index++;
          return { done: false, value: value as T };
        },
      };
    },
    subscribe(callback: (event: T) => void): () => void {
      subscribers.push(callback);
      return () => {
        const idx = subscribers.indexOf(callback);
        if (idx >= 0) {
          subscribers.splice(idx, 1);
        }
      };
    },
    cancel(): void {
      cancelled = true;
    },
  };

  return {
    ...observable,
    get cancelled() {
      return cancelled;
    },
    get subscribers() {
      return subscribers;
    },
  };
}

// ============================================================================
// Entity factories
// ============================================================================

/**
 * Creates a mock CLITool with sensible defaults.
 */
export function createMockCLITool(overrides: {
  id?: ToolId;
  name?: string;
  version?: string;
  binary?: string;
  chainable?: boolean;
  executionModel?: 'synchronous' | 'parallel';
  inputFormats?: readonly Format[];
  outputFormats?: readonly Format[];
  environmentRequirements?: import('../../src/types').EnvironmentRequirements;
  description?: string;
} = {}): CLITool {
  return {
    kind: 'cli',
    id: overrides.id ?? createToolId('cdo'),
    name: overrides.name ?? 'cdo',
    version: overrides.version ?? '2.0.5',
    binary: overrides.binary ?? 'cdo',
    chainable: overrides.chainable ?? true,
    executionModel: overrides.executionModel ?? 'synchronous',
    inputFormats: overrides.inputFormats ?? ['netcdf', 'grib2'],
    outputFormats: overrides.outputFormats ?? ['netcdf'],
    environmentRequirements: overrides.environmentRequirements ?? {
      uenvSpecs: [createMockUenvSpec()],
    },
    description: overrides.description ?? 'Climate Data Operators',
  };
}

/**
 * Creates a mock PythonTool with sensible defaults.
 */
export function createMockPythonTool(overrides: {
  id?: ToolId;
  name?: string;
  version?: string;
  moduleName?: string;
  functionName?: string;
  executionModel?: 'synchronous' | 'parallel';
  inputFormats?: readonly Format[];
  outputFormats?: readonly Format[];
  environmentRequirements?: import('../../src/types').EnvironmentRequirements;
  description?: string;
} = {}): PythonTool {
  return {
    kind: 'python',
    id: overrides.id ?? createToolId('healpy'),
    name: overrides.name ?? 'healpy',
    version: overrides.version ?? '1.16.2',
    moduleName: overrides.moduleName ?? 'healpy',
    functionName: overrides.functionName ?? 'angular_power_spectrum',
    executionModel: overrides.executionModel ?? 'synchronous',
    inputFormats: overrides.inputFormats ?? ['netcdf'],
    outputFormats: overrides.outputFormats ?? ['netcdf'],
    environmentRequirements: overrides.environmentRequirements ?? {
      uenvSpecs: [createMockUenvSpec({ name: 'python', version: '3.11.0' })],
    },
    description: overrides.description ?? 'healpy Python library',
  };
}

/**
 * Creates a mock ModelTool (CESM) with sensible defaults.
 */
export function createMockModelTool(overrides: {
  id?: ToolId;
  name?: string;
  version?: string;
  executionModel?: 'synchronous' | 'parallel';
  inputFormats?: readonly Format[];
  outputFormats?: readonly Format[];
  environmentRequirements?: import('../../src/types').EnvironmentRequirements;
  description?: string;
} = {}): ModelTool {
  return {
    kind: 'model',
    id: overrides.id ?? createToolId('cesm'),
    name: overrides.name ?? 'cesm',
    version: overrides.version ?? '2.1.5',
    executionModel: overrides.executionModel ?? 'parallel',
    inputFormats: overrides.inputFormats ?? ['netcdf'],
    outputFormats: overrides.outputFormats ?? ['netcdf'],
    environmentRequirements: overrides.environmentRequirements ?? {
      uenvSpecs: [
        createMockUenvSpec({ name: 'intel', version: '2021.4' }),
        createMockUenvSpec({ name: 'intel-mpi', version: '2021.4' }),
      ],
      compilerStack: {
        compiler: { name: 'intel', version: '2021.4', prefix: '/user-environment/env/intel/2021.4' },
        mpiRuntime: { name: 'intel-mpi', version: '2021.4', prefix: '/user-environment/env/intel-mpi/2021.4' },
        libraries: [],
      },
    },
    description: overrides.description ?? 'Community Earth System Model',
    lifecycleSteps: ['configure', 'build', 'submit', 'monitor', 'post-process'],
  };
}

/**
 * Creates a mock Environment with sensible defaults.
 */
export function createMockEnvironment(overrides: {
  id?: EnvironmentId;
  uenvSpecs?: readonly UenvSpec[];
  modules?: readonly import('../../src/types').Module[];
  conflictFree?: boolean;
  active?: boolean;
  loadedAt?: Date;
} = {}): Environment {
  const uenvSpecs = overrides.uenvSpecs ?? [createMockUenvSpec()];
  return {
    id: overrides.id ?? createEnvironmentId('env-test-001'),
    uenvSpecs,
    modules: overrides.modules ?? uenvSpecs.map((s) => ({
      name: s.name,
      version: s.version,
      prefix: s.mountPath,
    })),
    conflictFree: overrides.conflictFree ?? true,
    active: overrides.active ?? true,
    loadedAt: overrides.loadedAt ?? new Date('2026-09-15T12:00:00Z'),
  };
}

/**
 * Creates a mock Job with sensible defaults.
 */
export function createMockJob(overrides: {
  jobId?: JobId;
  userId?: import('../../src/types').UserId;
  resourceRequest?: ResourceRequest;
  state?: JobState;
  terminalState?: JobState | null;
  caseId?: CaseId;
  submittedAt?: Date;
  completedAt?: Date | null;
} = {}): Job {
  return {
    jobId: overrides.jobId ?? createJobId(4827365),
    userId: overrides.userId ?? ('cera_user' as import('../../src/types').UserId),
    resourceRequest: overrides.resourceRequest ?? createMockResourceRequest(),
    state: overrides.state ?? 'RUNNING',
    terminalState: overrides.terminalState ?? null,
    caseId: overrides.caseId,
    submittedAt: overrides.submittedAt ?? new Date('2026-09-15T12:00:00Z'),
    completedAt: overrides.completedAt ?? null,
  };
}

/**
 * Creates a mock Dataset with sensible defaults.
 */
export function createMockDataset(overrides: {
  id?: DatasetId;
  name?: string;
  location?: Location;
  format?: Format;
  grid?: Grid;
  variables?: readonly Variable[];
  producerToolInvocationId?: ToolInvocationId | null;
  consumable?: boolean;
  quarantined?: boolean;
  createdAt?: Date;
} = {}): Dataset {
  return Object.freeze({
    id: overrides.id ?? createDatasetId('ds-test-001'),
    name: overrides.name ?? 'test_dataset',
    location: overrides.location ?? createMockLocation(),
    format: overrides.format ?? 'netcdf',
    grid: overrides.grid ?? createMockGrid(),
    variables: overrides.variables ?? [createMockVariable()],
    producerToolInvocationId: overrides.producerToolInvocationId ?? null,
    consumable: overrides.consumable ?? false,
    quarantined: overrides.quarantined ?? false,
    createdAt: overrides.createdAt ?? new Date('2026-09-15T12:00:00Z'),
  });
}

/**
 * Creates a mock ToolInvocation with sensible defaults.
 */
export function createMockToolInvocation(overrides: {
  id?: ToolInvocationId;
  toolId?: ToolId;
  parameters?: Record<string, unknown>;
  inputDatasetIds?: readonly DatasetId[];
  outputDatasetIds?: readonly DatasetId[];
  environmentId?: EnvironmentId;
  state?: import('../../src/types').ToolInvocationState;
  exitOutcome?: ExitOutcome | null;
  permissiveExitCodes?: readonly number[];
  executionModel?: 'synchronous' | 'parallel';
  resourceRequest?: ResourceRequest;
  jobId?: JobId;
  createdAt?: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
} = {}): ToolInvocation {
  return Object.freeze({
    id: overrides.id ?? createToolInvocationId('ti-test-001'),
    toolId: overrides.toolId ?? createToolId('cdo'),
    parameters: overrides.parameters ?? { operatorChain: '-timmean' },
    inputDatasetIds: overrides.inputDatasetIds ?? [createDatasetId('ds-input-001')],
    outputDatasetIds: overrides.outputDatasetIds ?? [],
    environmentId: overrides.environmentId ?? createEnvironmentId('env-test-001'),
    state: overrides.state ?? 'NOT_STARTED',
    exitOutcome: overrides.exitOutcome ?? null,
    permissiveExitCodes: overrides.permissiveExitCodes ?? [],
    executionModel: overrides.executionModel ?? 'synchronous',
    resourceRequest: overrides.resourceRequest,
    jobId: overrides.jobId,
    createdAt: overrides.createdAt ?? new Date('2026-09-15T12:00:00Z'),
    startedAt: overrides.startedAt ?? null,
    completedAt: overrides.completedAt ?? null,
  });
}

/**
 * Creates a mock Case with sensible defaults.
 */
export function createMockCase(overrides: {
  id?: CaseId;
  name?: string;
  compset?: Compset;
  resolution?: string;
  machine?: string;
  runLength?: Duration;
  state?: CaseState;
  outputTreeLocation?: Location;
  jobId?: JobId | null;
  experimentId?: import('../../src/types').ExperimentId;
  createdAt?: Date;
} = {}): Case {
  return Object.freeze({
    id: overrides.id ?? createCaseId('case-test-001'),
    name: overrides.name ?? 'bhist_f09_g17_001',
    compset: overrides.compset ?? 'BHIST',
    resolution: overrides.resolution ?? 'f09_g17',
    machine: overrides.machine ?? 'daint',
    runLength: overrides.runLength ?? '5 years',
    state: overrides.state ?? 'CREATED',
    outputTreeLocation: overrides.outputTreeLocation ?? createMockLocation({
      path: '/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/',
    }),
    jobId: overrides.jobId ?? null,
    experimentId: overrides.experimentId ?? ('exp-test-001' as import('../../src/types').ExperimentId),
    createdAt: overrides.createdAt ?? new Date('2026-09-15T12:00:00Z'),
  });
}

/**
 * Creates a mock ProvenanceRecord with sensible defaults.
 */
export function createMockProvenanceRecord(overrides: {
  id?: ProvenanceRecordId;
  toolId?: ToolId;
  toolName?: string;
  toolVersion?: string;
  parameters?: Record<string, unknown>;
  environmentId?: EnvironmentId;
  environmentDescription?: string;
  inputDatasetIds?: readonly DatasetId[];
  outputDatasetId?: DatasetId | null;
  exitOutcome?: ExitOutcome;
  timestamp?: Date;
  jobId?: JobId;
  jobState?: JobState;
  caseId?: CaseId;
  warningFlag?: boolean;
} = {}): ProvenanceRecord {
  return Object.freeze({
    id: overrides.id ?? createProvenanceRecordId('pr-test-001'),
    toolId: overrides.toolId ?? createToolId('cdo'),
    toolName: overrides.toolName ?? 'cdo',
    toolVersion: overrides.toolVersion ?? '2.0.5',
    parameters: overrides.parameters ?? { operatorChain: '-timmean' },
    environmentId: overrides.environmentId ?? createEnvironmentId('env-test-001'),
    environmentDescription: overrides.environmentDescription ?? 'cdo/2.0.5 gcc/11.2.0',
    inputDatasetIds: overrides.inputDatasetIds ?? [createDatasetId('ds-input-001')],
    outputDatasetId: overrides.outputDatasetId ?? createDatasetId('ds-output-001'),
    exitOutcome: overrides.exitOutcome ?? createMockExitOutcome(),
    timestamp: overrides.timestamp ?? new Date('2026-09-15T12:00:00Z'),
    jobId: overrides.jobId,
    jobState: overrides.jobState,
    caseId: overrides.caseId,
    warningFlag: overrides.warningFlag,
  });
}
