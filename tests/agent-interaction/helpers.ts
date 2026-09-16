/**
 * Test helpers for the agent-interaction module (Phase 5).
 *
 * Provides mock factories for ALL dependencies
 * (SchedulingService, DataManagementService, ProvenanceService,
 * ToolInvocationService, ToolCatalogService, CaseService,
 * ToolRegistry, CommandRegistry) plus Session, User, Workflow,
 * WorkflowStep, Experiment, and Action factories so tests can
 * verify all four C7 invariants (INV-W1–W4) and all four failure
 * modes (FM-A1–A4) without real HPC services or an LLM.
 *
 * Spec: build-phases.md Phase 5 (Tier 1 — unit tests with all
 * mocked deps).
 */

import type { SchedulingService, SubmitJobInput } from '../../src/scheduling/types';
import type { DataManagementService, RegisterDatasetInput } from '../../src/data-management/types';
import type { ProvenanceService } from '../../src/provenance/types';
import type {
  ToolInvocationService,
  ToolInvocationRequest,
  ToolInvocationResult,
  ToolCatalogService,
  CaseService,
  CreateCaseInput,
  CaseConfig,
} from '../../src/tool-invocation/types';
import type {
  ToolRegistry,
  ToolCapability,
  CommandRegistry,
  HumanCommand,
} from '../../src/dsh-adapter/types';
import type {
  Action,
  ActionId,
  AsyncObservable,
  Case,
  CaseId,
  CaseState,
  Dataset,
  DatasetId,
  EnvironmentId,
  Experiment,
  ExitOutcome,
  Format,
  Grid,
  Job,
  JobId,
  JobState,
  Location,
  ResourceRequest,
  Session,
  SessionId,
  SessionState,
  Tool,
  ToolId,
  ToolInvocationEvent,
  User,
  Variable,
  Workflow,
  WorkflowId,
  WorkflowStep,
  WorkflowStepId,
  WorkflowState,
  JSONSchema,
} from '../../src/types';

// ============================================================================
// Branded ID factories (re-exported from types.ts for convenience)
// ============================================================================

export {
  createSessionId,
  createUserId,
  createExperimentId,
  createWorkflowId,
  createWorkflowStepId,
  createActionId,
  createDatasetId,
  createToolId,
  createJobId,
  createCaseId,
} from '../../src/agent-interaction/types';

import {
  createSessionId,
  createUserId,
  createExperimentId,
  createWorkflowId,
  createWorkflowStepId,
  createActionId,
  createDatasetId,
  createToolId,
  createJobId,
  createCaseId,
} from '../../src/agent-interaction/types';

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

export function createMockJSONSchema(overrides: Partial<JSONSchema> = {}): JSONSchema {
  return {
    type: 'object',
    properties: overrides.properties ?? {},
    required: overrides.required,
    additionalProperties: overrides.additionalProperties ?? true,
  };
}

// ============================================================================
// Entity factories
// ============================================================================

/**
 * Creates a mock User with sensible defaults.
 *
 * `slurmUsername` is used by `scheduling.queryJobsByUser()` for
 * proactive Job reporting (R7, ADR-007).
 */
export function createMockUser(overrides: {
  id?: string;
  username?: string;
  hpcAccount?: string;
  slurmUsername?: string;
} = {}): User {
  return {
    id: createUserId(overrides.id ?? 'cera_user'),
    username: overrides.username ?? 'cera_user',
    hpcAccount: overrides.hpcAccount ?? 's1234',
    slurmUsername: overrides.slurmUsername ?? 'cera_user',
  };
}

/**
 * Creates a mock Session with sensible defaults.
 *
 * Spec: domain-model.md C7 (Session aggregate); invariants.md
 * INV-W4; resolutions.md R7.
 */
export function createMockSession(overrides: {
  id?: SessionId;
  user?: User;
  state?: SessionState;
  currentWorkflowId?: WorkflowId | null;
  loadedEnvironmentId?: EnvironmentId | null;
  referencedDatasetIds?: readonly DatasetId[];
  startedAt?: Date;
  endedAt?: Date | null;
} = {}): Session {
  return Object.freeze({
    id: overrides.id ?? createSessionId('session-test-001'),
    user: overrides.user ?? createMockUser(),
    state: overrides.state ?? 'ACTIVE',
    currentWorkflowId: overrides.currentWorkflowId ?? null,
    loadedEnvironmentId: overrides.loadedEnvironmentId ?? null,
    referencedDatasetIds: overrides.referencedDatasetIds ?? [],
    startedAt: overrides.startedAt ?? new Date('2026-09-16T10:00:00Z'),
    endedAt: overrides.endedAt ?? null,
  });
}

/**
 * Creates a mock Experiment with sensible defaults.
 *
 * Spec: ADR-002; resolutions.md R2.
 */
export function createMockExperiment(overrides: {
  id?: string;
  name?: string;
  researchQuestion?: string;
  workflowIds?: readonly WorkflowId[];
  caseIds?: readonly CaseId[];
  createdAt?: Date;
} = {}): Experiment {
  return Object.freeze({
    id: createExperimentId(overrides.id ?? 'exp-test-001'),
    name: overrides.name ?? 'CO2 doubling sensitivity study',
    researchQuestion:
      overrides.researchQuestion ?? 'How does doubling CO2 affect global mean temperature?',
    workflowIds: overrides.workflowIds ?? [],
    caseIds: overrides.caseIds ?? [],
    createdAt: overrides.createdAt ?? new Date('2026-09-16T10:00:00Z'),
  });
}

/**
 * Creates a mock Workflow with sensible defaults.
 *
 * Spec: ADR-006; resolutions.md R6.
 */
export function createMockWorkflow(overrides: {
  id?: WorkflowId;
  name?: string;
  experimentId?: string;
  state?: WorkflowState;
  steps?: readonly WorkflowStep[];
  createdAt?: Date;
  updatedAt?: Date;
} = {}): Workflow {
  return Object.freeze({
    id: overrides.id ?? createWorkflowId('wf-test-001'),
    name: overrides.name ?? 'annual_mean_workflow',
    experimentId: createExperimentId(overrides.experimentId ?? 'exp-test-001'),
    state: overrides.state ?? 'NOT_STARTED',
    steps: overrides.steps ?? [],
    createdAt: overrides.createdAt ?? new Date('2026-09-16T10:00:00Z'),
    updatedAt: overrides.updatedAt ?? new Date('2026-09-16T10:00:00Z'),
  });
}

/**
 * Creates a mock WorkflowStep with sensible defaults.
 *
 * Spec: domain-model.md C7; invariants.md INV-W1–W3.
 */
export function createMockWorkflowStep(overrides: {
  id?: WorkflowStepId;
  order?: number;
  name?: string;
  toolId?: ToolId;
  parameters?: Record<string, unknown>;
  inputDatasetIds?: readonly DatasetId[];
  outputDatasetId?: DatasetId;
  executionModel?: 'synchronous' | 'parallel';
  resourceRequest?: ResourceRequest;
  state?: 'NOT_STARTED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'BLOCKED';
  toolInvocationId?: import('../../src/types').ToolInvocationId;
  jobId?: JobId;
} = {}): WorkflowStep {
  return Object.freeze({
    id: overrides.id ?? createWorkflowStepId('ws-test-001'),
    order: overrides.order ?? 1,
    name: overrides.name ?? 'select_tas',
    toolId: overrides.toolId ?? createToolId('cdo'),
    parameters: overrides.parameters ?? { operatorChain: '-selname,TAS' },
    inputDatasetIds: overrides.inputDatasetIds ?? [createDatasetId('ds-input-001')],
    outputDatasetId: overrides.outputDatasetId,
    executionModel: overrides.executionModel ?? 'synchronous',
    resourceRequest: overrides.resourceRequest,
    state: overrides.state ?? 'NOT_STARTED',
    toolInvocationId: overrides.toolInvocationId,
    jobId: overrides.jobId,
  });
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
    producerToolInvocationId: null,
    consumable: overrides.consumable ?? false,
    quarantined: overrides.quarantined ?? false,
    createdAt: overrides.createdAt ?? new Date('2026-09-16T12:00:00Z'),
  });
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
  workflowId?: WorkflowId;
  submittedAt?: Date;
  completedAt?: Date | null;
} = {}): Job {
  return {
    jobId: overrides.jobId ?? createJobId(4827365),
    userId: overrides.userId ?? createUserId('cera_user'),
    resourceRequest: overrides.resourceRequest ?? createMockResourceRequest(),
    state: overrides.state ?? 'RUNNING',
    terminalState: overrides.terminalState ?? null,
    caseId: overrides.caseId,
    workflowId: overrides.workflowId,
    submittedAt: overrides.submittedAt ?? new Date('2026-09-16T12:00:00Z'),
    completedAt: overrides.completedAt ?? null,
  };
}

/**
 * Creates a mock Case with sensible defaults.
 */
export function createMockCase(overrides: {
  id?: CaseId;
  name?: string;
  compset?: string;
  resolution?: string;
  machine?: string;
  runLength?: string;
  state?: CaseState;
  outputTreeLocation?: Location;
  jobId?: JobId | null;
  experimentId?: string;
  createdAt?: Date;
} = {}): Case {
  return Object.freeze({
    id: overrides.id ?? createCaseId('case-test-001'),
    name: overrides.name ?? 'bhist_f09_g17_001',
    compset: overrides.compset ?? 'BHIST',
    resolution: overrides.resolution ?? 'f09_g17',
    machine: overrides.machine ?? 'daint',
    runLength: overrides.runLength ?? '5 years',
    state: overrides.state ?? 'BUILT',
    outputTreeLocation: overrides.outputTreeLocation ?? createMockLocation({
      path: '/scratch/snx3000/cera_user/cases/bhist_f09_g17_001/run/',
    }),
    jobId: overrides.jobId ?? null,
    experimentId: createExperimentId(overrides.experimentId ?? 'exp-test-001'),
    createdAt: overrides.createdAt ?? new Date('2026-09-16T12:00:00Z'),
  });
}

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
  description?: string;
} = {}): Tool {
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
    environmentRequirements: {
      uenvSpecs: [{ name: 'cdo', version: '2.0.5', mountPath: '/user-environment/env/cdo/2.0.5' }],
    },
    description: overrides.description ?? 'Climate Data Operators',
  } as Tool;
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
  description?: string;
} = {}): Tool {
  return {
    kind: 'model',
    id: overrides.id ?? createToolId('cesm'),
    name: overrides.name ?? 'cesm',
    version: overrides.version ?? '2.1.5',
    executionModel: overrides.executionModel ?? 'parallel',
    inputFormats: overrides.inputFormats ?? ['netcdf'],
    outputFormats: overrides.outputFormats ?? ['netcdf'],
    environmentRequirements: {
      uenvSpecs: [
        { name: 'intel', version: '2021.4', mountPath: '/user-environment/env/intel/2021.4' },
        { name: 'intel-mpi', version: '2021.4', mountPath: '/user-environment/env/intel-mpi/2021.4' },
      ],
    },
    description: overrides.description ?? 'Community Earth System Model',
    lifecycleSteps: ['configure', 'build', 'submit', 'monitor', 'post-process'],
  } as Tool;
}

/**
 * Creates a mock Action with sensible defaults.
 *
 * Spec: resolutions.md R3; ADR-010.
 */
export function createMockAction(overrides: {
  id?: ActionId;
  name?: string;
  description?: string;
  toolId?: ToolId;
  parameterSchema?: JSONSchema;
  inputRequirements?: {
    formats: readonly Format[];
    grids: readonly Grid[];
    variables?: readonly string[];
  };
  outputDescription?: {
    format: Format;
    grid?: Grid;
  };
} = {}): Action {
  return Object.freeze({
    id: overrides.id ?? createActionId('action-select-variable'),
    name: overrides.name ?? 'select_variable',
    description: overrides.description ?? 'Select a variable from a Dataset',
    toolId: overrides.toolId ?? createToolId('cdo'),
    parameterSchema: overrides.parameterSchema ?? createMockJSONSchema({
      type: 'object',
      properties: {
        operatorChain: { type: 'string', description: 'CDO operator chain' },
      },
      required: ['operatorChain'],
    }),
  inputRequirements: overrides.inputRequirements ?? {
    formats: ['netcdf', 'grib2'] as readonly Format[],
    grids: [createMockGrid()] as readonly Grid[],
    variables: ['TAS'] as readonly string[],
  },
    outputDescription: overrides.outputDescription ?? {
      format: 'netcdf' as const,
      grid: createMockGrid(),
    },
  });
}

// ============================================================================
// Mock SchedulingService
// ============================================================================

/**
 * A configurable mock SchedulingService.
 *
 * `queryJobsByUserResult` — Jobs to return from queryJobsByUser().
 * `queryJobResult` — function returning a Job for a given JobId.
 * `submitJobResult` — Job to return from submitJob().
 *
 * Call tracking: `submitCalls`, `queryCalls`, `queryJobsByUserCalls`,
 * `cancelCalls`.
 */
export function createMockSchedulingService(overrides: {
  readonly queryJobsByUserResult?: readonly Job[];
  readonly queryJobResult?: (jobId: JobId) => Job;
  readonly submitJobResult?: Job;
  readonly submitJobError?: Error;
  readonly queryJobsByUserError?: Error;
} = {}): SchedulingService & {
  readonly submitCalls: SubmitJobInput[];
  readonly queryCalls: JobId[];
  readonly queryJobsByUserCalls: string[];
  readonly cancelCalls: JobId[];
  setQueryJobResult: (fn: (jobId: JobId) => Job) => void;
  setQueryJobsByUserResult: (jobs: readonly Job[]) => void;
} {
  const submitCalls: SubmitJobInput[] = [];
  const queryCalls: JobId[] = [];
  const queryJobsByUserCalls: string[] = [];
  const cancelCalls: JobId[] = [];
  let queryFn = overrides.queryJobResult ?? ((_jobId: JobId): Job => {
    return overrides.submitJobResult ?? createMockJob({ state: 'RUNNING' });
  });
  let jobsByUserResult = overrides.queryJobsByUserResult ?? [];

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
    async queryJobsByUser(username: string): Promise<Job[]> {
      queryJobsByUserCalls.push(username);
      if (overrides.queryJobsByUserError) {
        throw overrides.queryJobsByUserError;
      }
      return [...jobsByUserResult];
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
    queryJobsByUserCalls,
    cancelCalls,
    setQueryJobResult: (fn: (jobId: JobId) => Job) => {
      queryFn = fn;
    },
    setQueryJobsByUserResult: (jobs: readonly Job[]) => {
      jobsByUserResult = [...jobs];
    },
  };
}

// ============================================================================
// Mock DataManagementService
// ============================================================================

/**
 * A configurable mock DataManagementService.
 *
 * `datasets` — initial Datasets in the store.
 * `validateLocationResult` — what validateLocation() returns.
 * `markConsumableResult` — what markConsumable() does (default: set consumable=true).
 *
 * Call tracking: `registerCalls`, `queryCalls`, `validateLocationCalls`,
 * `markConsumableCalls`, `quarantineCalls`.
 */
export function createMockDataManagementService(overrides: {
  readonly datasets?: ReadonlyMap<DatasetId, Dataset>;
  readonly validateLocationResult?: boolean;
  readonly validateLocationError?: Error;
  readonly markConsumableError?: Error;
} = {}): DataManagementService & {
  readonly registerCalls: RegisterDatasetInput[];
  readonly queryCalls: DatasetId[];
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
  const queryCalls: DatasetId[] = [];
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
      queryCalls.push(id);
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
    queryCalls,
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
// Mock ProvenanceService
// ============================================================================

/**
 * A configurable mock ProvenanceService.
 *
 * `verifyResult` — what verifyProvenance() returns. Default: true.
 * `verifyResults` — per-DatasetId override (takes precedence over verifyResult).
 *
 * Call tracking: `verifyCalls`, `writeCalls`, `quarantineCalls`.
 */
export function createMockProvenanceService(overrides: {
  readonly verifyResult?: boolean;
  readonly verifyResults?: ReadonlyMap<DatasetId, boolean>;
  readonly writeResult?: import('../../src/types').ProvenanceRecord;
  readonly writeError?: Error;
} = {}): ProvenanceService & {
  readonly verifyCalls: DatasetId[];
  readonly writeCalls: import('../../src/provenance/types').WriteProvenanceInput[];
  readonly quarantineCalls: { readonly datasetId: DatasetId; readonly reason: string }[];
  setVerifyResult: (result: boolean) => void;
  setVerifyResultFor: (datasetId: DatasetId, result: boolean) => void;
} {
  const verifyCalls: DatasetId[] = [];
  const writeCalls: import('../../src/provenance/types').WriteProvenanceInput[] = [];
  const quarantineCalls: { datasetId: DatasetId; reason: string }[] = [];
  let defaultVerify = overrides.verifyResult ?? true;
  const perDatasetVerify = new Map<DatasetId, boolean>(
    overrides.verifyResults ? Array.from(overrides.verifyResults) : [],
  );

  const service: ProvenanceService = {
    async writeProvenanceRecord(
      input: import('../../src/provenance/types').WriteProvenanceInput,
    ): Promise<import('../../src/types').ProvenanceRecord> {
      writeCalls.push(input);
      if (overrides.writeError) {
        throw overrides.writeError;
      }
      return (
        overrides.writeResult ?? {
          id: `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as import('../../src/types').ProvenanceRecordId,
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
          warningFlag: undefined,
          defective: undefined,
        }
      );
    },
    async queryProvenanceRecord(_datasetId: DatasetId): Promise<import('../../src/types').ProvenanceRecord | null> {
      return null;
    },
    async queryProvenanceForJob(_jobId: JobId): Promise<import('../../src/types').ProvenanceRecord | null> {
      return null;
    },
    async queryLineage(_datasetId: DatasetId): Promise<import('../../src/types').ProvenanceRecord[]> {
      return [];
    },
    async verifyProvenance(datasetId: DatasetId): Promise<boolean> {
      verifyCalls.push(datasetId);
      const perDataset = perDatasetVerify.get(datasetId);
      if (perDataset !== undefined) {
        return perDataset;
      }
      return defaultVerify;
    },
    async reconstructProvenanceRecord(
      _input: import('../../src/provenance/types').ReconstructInput,
    ): Promise<import('../../src/types').ProvenanceRecord | null> {
      return null;
    },
    async quarantineDataset(datasetId: DatasetId, reason: string): Promise<void> {
      quarantineCalls.push({ datasetId, reason });
    },
  };

  return {
    ...service,
    verifyCalls,
    writeCalls,
    quarantineCalls,
    setVerifyResult: (result: boolean) => {
      defaultVerify = result;
    },
    setVerifyResultFor: (datasetId: DatasetId, result: boolean) => {
      perDatasetVerify.set(datasetId, result);
    },
  };
}

// ============================================================================
// Mock ToolInvocationService
// ============================================================================

/**
 * A configurable mock ToolInvocationService.
 *
 * `result` — the ToolInvocationResult to return from invokeTool().
 * `error` — if set, invokeTool() throws this error.
 *
 * Call tracking: `invokeCalls`, `monitorCalls`.
 */
export function createMockToolInvocationService(overrides: {
  readonly result?: ToolInvocationResult;
  readonly error?: Error;
} = {}): ToolInvocationService & {
  readonly invokeCalls: ToolInvocationRequest[];
  readonly monitorCalls: string[];
  setResult: (result: ToolInvocationResult) => void;
  setError: (error: Error | undefined) => void;
} {
  const invokeCalls: ToolInvocationRequest[] = [];
  const monitorCalls: string[] = [];
  let currentResult = overrides.result;
  let currentError = overrides.error;

  const service: ToolInvocationService = {
    async invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult> {
      invokeCalls.push(request);
      if (currentError) {
        throw currentError;
      }
      return (
        currentResult ?? {
          invocation: Object.freeze({
            id: `ti-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as import('../../src/types').ToolInvocationId,
            toolId: request.toolId,
            parameters: request.parameters,
            inputDatasetIds: request.inputDatasetIds,
            outputDatasetIds: [],
            environmentId: 'env-test-001' as EnvironmentId,
            state: 'COMPLETED' as const,
            exitOutcome: { kind: 'exit_code' as const, code: 0 },
            permissiveExitCodes: request.permissiveExitCodes ?? [],
            executionModel: request.executionModel,
            resourceRequest: request.resourceRequest,
            createdAt: new Date(),
            startedAt: new Date(),
            completedAt: new Date(),
          }),
          outputDatasets: [
            Object.freeze({
              id: createDatasetId(`ds-output-${Date.now()}`),
              name: 'output_dataset',
              location: request.outputLocation,
              format: 'netcdf',
              grid: createMockGrid(),
              variables: [createMockVariable()],
              producerToolInvocationId: `ti-${Date.now()}` as import('../../src/types').ToolInvocationId,
              consumable: true,
              quarantined: false,
              createdAt: new Date(),
            }),
          ],
          provenanceRecord: Object.freeze({
            id: `pr-${Date.now()}` as import('../../src/types').ProvenanceRecordId,
            toolId: request.toolId,
            toolName: 'mock-tool',
            toolVersion: '1.0.0',
            parameters: request.parameters,
            environmentId: 'env-test-001' as EnvironmentId,
            environmentDescription: 'mock',
            inputDatasetIds: request.inputDatasetIds,
            outputDatasetId: createDatasetId(`ds-output-${Date.now()}`),
            exitOutcome: { kind: 'exit_code' as const, code: 0 },
            timestamp: new Date(),
          }),
        }
      );
    },
    monitorInvocation(invocationId: import('../../src/types').ToolInvocationId): AsyncObservable<ToolInvocationEvent> {
      monitorCalls.push(invocationId as string);
      return createMockAsyncObservable<ToolInvocationEvent>([]);
    },
  };

  return {
    ...service,
    invokeCalls,
    monitorCalls,
    setResult: (result: ToolInvocationResult) => {
      currentResult = result;
    },
    setError: (error: Error | undefined) => {
      currentError = error;
    },
  };
}

// ============================================================================
// Mock ToolCatalogService
// ============================================================================

/**
 * A configurable mock ToolCatalogService.
 *
 * `tools` — initial Tools in the catalog.
 *
 * Call tracking: `getToolCalls`, `getCatalogCalls`, `registerCalls`.
 */
export function createMockToolCatalogService(overrides: {
  readonly tools?: readonly Tool[];
} = {}): ToolCatalogService & {
  readonly tools: Map<string, Tool>;
  readonly getToolCalls: ToolId[];
  readonly getCatalogCalls: number;
  readonly registerCalls: Tool[];
} {
  const tools = new Map<string, Tool>();
  for (const tool of overrides.tools ?? []) {
    tools.set(tool.id as string, tool);
  }
  const getToolCalls: ToolId[] = [];
  let getCatalogCalls = 0;
  const registerCalls: Tool[] = [];

  const service: ToolCatalogService = {
    async getToolCatalog(): Promise<readonly Tool[]> {
      getCatalogCalls++;
      return Array.from(tools.values());
    },
    async getTool(toolId: ToolId): Promise<Tool | null> {
      getToolCalls.push(toolId);
      return tools.get(toolId as string) ?? null;
    },
    async registerTool(tool: Tool): Promise<void> {
      registerCalls.push(tool);
      tools.set(tool.id as string, tool);
    },
  };

  return {
    ...service,
    tools,
    getToolCalls,
    getCatalogCalls,
    registerCalls,
  };
}

// ============================================================================
// Mock CaseService
// ============================================================================

/**
 * A configurable mock CaseService.
 *
 * `cases` — initial Cases in the store.
 * `submitResult` — the Case to return from submitCase() (overrides the stored Case).
 * `submitError` — if set, submitCase() throws this error.
 *
 * Call tracking: `createCalls`, `configureCalls`, `buildCalls`,
 * `submitCalls`, `monitorCalls`, `registerOutputCalls`.
 */
export function createMockCaseService(overrides: {
  readonly cases?: readonly Case[];
  readonly submitResult?: Case;
  readonly submitError?: Error;
  readonly createError?: Error;
  readonly outputScannerResult?: readonly Dataset[];
} = {}): CaseService & {
  readonly store: Map<string, Case>;
  readonly createCalls: CreateCaseInput[];
  readonly configureCalls: { caseId: CaseId; config: CaseConfig }[];
  readonly buildCalls: CaseId[];
  readonly submitCalls: { caseId: CaseId; resourceRequest: ResourceRequest }[];
  readonly monitorCalls: CaseId[];
  readonly registerOutputCalls: CaseId[];
  setCase: (caseEntity: Case) => void;
  setSubmitResult: (result: Case) => void;
  setSubmitError: (error: Error | undefined) => void;
} {
  const store = new Map<string, Case>();
  for (const c of overrides.cases ?? []) {
    store.set(c.id as string, c);
  }
  const createCalls: CreateCaseInput[] = [];
  const configureCalls: { caseId: CaseId; config: CaseConfig }[] = [];
  const buildCalls: CaseId[] = [];
  const submitCalls: { caseId: CaseId; resourceRequest: ResourceRequest }[] = [];
  const monitorCalls: CaseId[] = [];
  const registerOutputCalls: CaseId[] = [];
  let submitResultOverride = overrides.submitResult;
  let submitErrorOverride = overrides.submitError;

  const service: CaseService = {
    async createCase(input: CreateCaseInput): Promise<Case> {
      createCalls.push(input);
      if (overrides.createError) {
        throw overrides.createError;
      }
      const newCase = Object.freeze({
        id: `case-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` as CaseId,
        name: input.name,
        compset: input.compset,
        resolution: input.resolution,
        machine: input.machine,
        runLength: input.runLength,
        state: 'CREATED' as CaseState,
        outputTreeLocation: createMockLocation({
          path: `/scratch/snx3000/cera_user/cases/${input.name}/run/`,
        }),
        jobId: null,
        experimentId: input.experimentId,
        createdAt: new Date(),
      });
      store.set(newCase.id as string, newCase);
      return newCase;
    },
    async configureCase(caseId: CaseId, config: CaseConfig): Promise<Case> {
      configureCalls.push({ caseId, config });
      const existing = store.get(caseId as string);
      if (existing === undefined) {
        throw new Error(`Case '${caseId as string}' not found.`);
      }
      const configured = Object.freeze({ ...existing, state: 'CONFIGURED' as CaseState });
      store.set(caseId as string, configured);
      return configured;
    },
    async buildCase(caseId: CaseId): Promise<Case> {
      buildCalls.push(caseId);
      const existing = store.get(caseId as string);
      if (existing === undefined) {
        throw new Error(`Case '${caseId as string}' not found.`);
      }
      const built = Object.freeze({ ...existing, state: 'BUILT' as CaseState });
      store.set(caseId as string, built);
      return built;
    },
    async submitCase(caseId: CaseId, resourceRequest: ResourceRequest): Promise<Case> {
      submitCalls.push({ caseId, resourceRequest });
      if (submitErrorOverride) {
        throw submitErrorOverride;
      }
      if (submitResultOverride) {
        store.set(submitResultOverride.id as string, submitResultOverride);
        return submitResultOverride;
      }
      const existing = store.get(caseId as string);
      if (existing === undefined) {
        throw new Error(`Case '${caseId as string}' not found.`);
      }
      const submitted = Object.freeze({
        ...existing,
        state: 'SUBMITTED' as CaseState,
        jobId: createJobId(4827365),
      });
      store.set(caseId as string, submitted);
      return submitted;
    },
    monitorCase(caseId: CaseId): AsyncObservable<CaseState> {
      monitorCalls.push(caseId);
      return createMockAsyncObservable<CaseState>([]);
    },
    async registerCaseOutput(caseId: CaseId): Promise<readonly Dataset[]> {
      registerOutputCalls.push(caseId);
      return overrides.outputScannerResult ?? [];
    },
  };

  return {
    ...service,
    store,
    createCalls,
    configureCalls,
    buildCalls,
    submitCalls,
    monitorCalls,
    registerOutputCalls,
    setCase: (caseEntity: Case) => {
      store.set(caseEntity.id as string, caseEntity);
    },
    setSubmitResult: (result: Case) => {
      submitResultOverride = result;
    },
    setSubmitError: (error: Error | undefined) => {
      submitErrorOverride = error;
    },
  };
}

// ============================================================================
// Mock ToolRegistry (dsh-adapter)
// ============================================================================

/**
 * A configurable mock ToolRegistry (wraps ctx.tools).
 *
 * Call tracking: `registerCalls`, `listCalls`.
 */
export function createMockToolRegistry(overrides: {
  readonly existing?: readonly ToolCapability[];
} = {}): ToolRegistry & {
  readonly registered: ToolCapability[];
  readonly registerCalls: ToolCapability[];
  readonly listCalls: number;
} {
  const registered: ToolCapability[] = [...(overrides.existing ?? [])];
  const registerCalls: ToolCapability[] = [];
  let listCalls = 0;

  const registry: ToolRegistry = {
    async register(capability: ToolCapability): Promise<void> {
      registerCalls.push(capability);
      registered.push(capability);
    },
    async list(): Promise<ToolCapability[]> {
      listCalls++;
      return [...registered];
    },
  };

  return {
    ...registry,
    registered,
    registerCalls,
    listCalls,
  };
}

// ============================================================================
// Mock CommandRegistry (dsh-adapter)
// ============================================================================

/**
 * A configurable mock CommandRegistry (wraps ctx.commands).
 *
 * Call tracking: `registerCalls`, `listCalls`.
 */
export function createMockCommandRegistry(overrides: {
  readonly existing?: readonly HumanCommand[];
} = {}): CommandRegistry & {
  readonly registered: HumanCommand[];
  readonly registerCalls: HumanCommand[];
  readonly listCalls: number;
} {
  const registered: HumanCommand[] = [...(overrides.existing ?? [])];
  const registerCalls: HumanCommand[] = [];
  let listCalls = 0;

  const registry: CommandRegistry = {
    async register(command: HumanCommand): Promise<void> {
      registerCalls.push(command);
      registered.push(command);
    },
    async list(): Promise<HumanCommand[]> {
      listCalls++;
      return [...registered];
    },
  };

  return {
    ...registry,
    registered,
    registerCalls,
    listCalls,
  };
}

// ============================================================================
// Mock AsyncObservable
// ============================================================================

/**
 * Creates a mock AsyncObservable that emits a predefined sequence of
 * events. Once all events are emitted, the observable completes.
 */
export function createMockAsyncObservable<T>(events: readonly T[]): AsyncObservable<T> & {
  readonly cancelled: boolean;
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
  };
}

// ============================================================================
// End of helpers
// ============================================================================
