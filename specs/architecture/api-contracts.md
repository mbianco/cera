# API Contracts — cera

> TypeScript interface definitions for each module's public surface.
> These are **contracts**, not implementations. Stubs live in
> `src/types/`.
>
> All interfaces reference error types from `error-taxonomy.md` and
> event types from `src/types/events.ts`.

---

## Shared Types

See `src/types/` for full type definitions. Key shared types used
across contracts:

```typescript
import type {
  // Value objects
  DatasetId, EnvironmentId, JobId, ToolId, CaseId,
  WorkflowId, ExperimentId, SessionId, ActionId,
  ProvenanceRecordId, UenvSpec,
  Format, Grid, Variable, Location,
  ResourceRequest, ExitOutcome, JobState, CaseState,
  WorkflowState, SessionState,
  // Entities
  Dataset, Environment, Job, Tool, Case,
  ProvenanceRecord, Workflow, WorkflowStep, Experiment, Session, User, Action,
  // Events
  ToolInvocationEvent, JobEvent, DatasetEvent, ProvenanceEvent,
  WorkflowEvent, SessionEvent,
  // Errors
  CeraError, ToolInvocationError, SchedulingError,
  EnvironmentError, DataError, ProvenanceError,
  AgentError, DshAdapterError,
} from '../types';
```

---

## 1. dsh-adapter

The isolation layer between dsh and cera domain interfaces. See
ADR-005 for design rationale.

```typescript
/**
 * Wraps ctx.shell for CLI tool execution.
 * Returns stdout, stderr, and ExitOutcome.
 */
interface ShellExecutor {
  execute(command: string, options?: ShellExecuteOptions): Promise<ShellResult>;
}

interface ShellExecuteOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number; // milliseconds
  stdin?: string;
}

interface ShellResult {
  stdout: string;
  stderr: string;
  exitOutcome: ExitOutcome;
}

/**
 * Wraps ctx.subprocess for fine-grained process control.
 * Supports streaming stdout/stderr for long-running processes.
 */
interface SubprocessRunner {
  spawn(command: string, args: string[], options?: SubprocessOptions): SubprocessHandle;
  execute(command: string, args: string[], options?: SubprocessOptions): Promise<ShellResult>;
}

interface SubprocessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  stdin?: string;
}

interface SubprocessHandle {
  pid: number;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
  kill(signal?: string): Promise<void>;
  wait(): Promise<ShellResult>;
}

/**
 * Wraps ctx.sandbox for process confinement.
 * Used for executing legacy binaries with restricted filesystem
 * and network access.
 */
interface SandboxRunner {
  execute(command: string, options?: SandboxOptions): Promise<ShellResult>;
  spawn(command: string, args: string[], options?: SandboxOptions): SubprocessHandle;
}

interface SandboxOptions extends SubprocessOptions {
  allowedPaths?: string[]; // filesystem paths the sandboxed process may access
  allowNetwork?: boolean;
}

/**
 * Wraps ctx.fs for filesystem access and validation.
 */
interface FilesystemGateway {
  exists(path: string): Promise<boolean>;
  isReadable(path: string): Promise<boolean>;
  isWritable(path: string): Promise<boolean>;
  stat(path: string): Promise<FileStat>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: Buffer): Promise<void>;
  readDir(path: string): Promise<string[]>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
}

interface FileStat {
  size: number;
  isFile: boolean;
  isDirectory: boolean;
  mtime: Date;
}

/**
 * Wraps ctx.jobs for background work submission.
 */
interface JobBackend {
  submit(work: BackgroundWork): Promise<string>; // returns work ID
  query(workId: string): Promise<BackgroundWorkStatus>;
  cancel(workId: string): Promise<void>;
}

/**
 * Wraps ctx.tools for model-facing capability registration.
 */
interface ToolRegistry {
  register(capability: ToolCapability): Promise<void>;
  list(): Promise<ToolCapability[]>;
}

/**
 * Wraps ctx.commands for human-command dispatch.
 */
interface CommandRegistry {
  register(command: HumanCommand): Promise<void>;
  list(): Promise<HumanCommand[]>;
}
```

**dsh events consumed:** All dsh extension-point events are internal to
`dsh-adapter` and not exposed to cera modules. The adapter translates
dsh events into cera events (defined in `src/types/events.ts`).

---

## 2. scheduling (C4 — SLURM)

```typescript
/**
 * SLURM job management. SLURM-only, no scheduler abstraction
 * (R8, ADR-004).
 */
interface SchedulingService {
  /**
   * Submits a Job to SLURM via `sbatch`.
   * The Scheduler assigns the JobID (INV-S3). The ResourceRequest
   * is immutable after submission (INV-S2).
   *
   * @throws {SchedulingError.RejectedByScheduler} if sbatch rejects
   *   the ResourceRequest (FM-S1).
   * @throws {SchedulingError.SchedulerUnavailable} if SLURM is
   *   unreachable (FM-S2).
   */
  submitJob(request: SubmitJobInput): Promise<Job>;

  /**
   * Queries a single Job's state via `squeue` (active) or `sacct`
   * (historical). The state is authoritative — taken directly from
   * SLURM output, never inferred from file existence (INV-S1).
   *
   * @throws {SchedulingError.SchedulerUnavailable} if SLURM is
   *   unreachable. The caller should mark the Job as UNKNOWN and
   *   retry with backoff (R13).
   */
  queryJob(jobId: JobId): Promise<Job>;

  /**
   * Queries all Jobs for a User. Used by agent-interaction for
   * proactive Job reporting on Session start (R7).
   */
  queryJobsByUser(username: string): Promise<Job[]>;

  /**
   * Cancels a Job via `scancel`.
   *
   * @throws {SchedulingError.JobNotFound} if the Job does not exist.
   * @throws {SchedulingError.SchedulerUnavailable} if SLURM is
   *   unreachable.
   */
  cancelJob(jobId: JobId): Promise<void>;

  /**
   * Reconciles Job states using `sacct` (historical data) after a
   * SLURM outage. Finds Jobs that completed during the outage
   * (FM-S2, R13).
   */
  reconcileViaSacct(jobIds: JobId[]): Promise<Job[]>;
}

interface SubmitJobInput {
  resourceRequest: ResourceRequest;
  command: string;       // the sbatch script or command
  workingDirectory?: string;
  environmentVars?: Record<string, string>;
}

/**
 * @returns AsyncObservable<JobEvent> that emits state changes.
 * Used by tool-invocation to monitor long-running Jobs (CESM).
 */
interface JobMonitor {
  watch(jobId: JobId): AsyncObservable<JobEvent>;
}
```

**Events produced:** `JobEvent.submitted`, `JobEvent.state_changed`,
`JobEvent.cancelled`, `JobEvent.timeout`, `JobEvent.node_fail`,
`JobEvent.unknown`.

**Events consumed:** None (SLURM is the authority; the module polls,
it does not consume events from other modules).

---

## 3. environment-management (C5 — uenv)

```typescript
/**
 * uenv-based environment management. Not Lmod (R9, ADR-003).
 * Environments are squashfs mounts at prescribed paths.
 */
interface EnvironmentService {
  /**
   * Checks whether a uenv exists in the uenv registry (INV-E3).
   * Replaces `module avail` / `module spider`.
   */
  checkUenvAvailability(name: string, version: string): Promise<boolean>;

  /**
   * Mounts a uenv (squashfs) at its prescribed path, verifies the
   * mount is conflict-free (INV-E1, INV-E2), and returns an active
   * Environment.
   *
   * @throws {EnvironmentError.UenvNotFound} if the uenv does not
   *   exist (FM-E1).
   * @throws {EnvironmentError.ConflictDetected} if the uenv
   *   conflicts with the currently active Environment (FM-E2).
   * @throws {EnvironmentError.PartialLoad} if the mount partially
   *   succeeds (FM-E3).
   */
  loadUenv(request: LoadUenvInput): Promise<Environment>;

  /**
   * Unmounts a uenv.
   */
  unloadUenv(environmentId: EnvironmentId): Promise<void>;

  /**
   * Re-verifies an Environment is still active and conflict-free.
   * Called by tool-invocation immediately before a ToolInvocation
   * starts (X1 "out-of-order" case: env may have been purged or
   * replaced by another process between load and invocation).
   *
   * @throws {EnvironmentError.NotActive} if the Environment is no
   *   longer active.
   * @throws {EnvironmentError.ConflictDetected} if a conflict has
   *   appeared since the initial load.
   */
  verifyEnvironment(environmentId: EnvironmentId): Promise<boolean>;

  /**
   * Detects filesystem path conflicts between uenvs (INV-E2,
   * updated for uenv: path-level, not soname-level).
   */
  detectConflicts(uenvSpecs: UenvSpec[]): Promise<Conflict[]>;

  /**
   * Returns the currently active Environment, or null if none.
   * At most one Environment is active per execution context (INV-E1).
   */
  getActiveEnvironment(): Environment | null;
}

interface LoadUenvInput {
  uenvSpec: UenvSpec;
  /**
   * Tool binary paths that must be available after loading.
   * Used for INV-T1 verification: the Environment must contain
   * the Tool's binary. (Subsumes X14.)
   */
  requiredBinaryPaths?: string[];
}

interface Conflict {
  uenvA: UenvSpec;
  uenvB: UenvSpec;
  conflictPath: string;  // the filesystem path that conflicts
  conflictType: 'path' | 'library' | 'compiler';
  description: string;
}
```

**Events produced:** `EnvironmentEvent.loaded`, `EnvironmentEvent.
unloaded`, `EnvironmentEvent.conflict_detected`, `EnvironmentEvent.
verification_failed`.

**Events consumed:** None (C5 is a leaf module in the dependency
graph).

---

## 4. provenance (C6)

```typescript
/**
 * Provenance recording and querying. ProvenanceRecords are immutable
 * (INV-P1) and persist across Sessions (INV-P4).
 */
interface ProvenanceService {
  /**
   * Writes an immutable ProvenanceRecord. All fields must be
   * non-null (INV-P2).
   *
   * @throws {ProvenanceError.WriteFailed} if the store is
   *   unreachable or the write fails (FM-P1).
   * @throws {ProvenanceError.MissingField} if any field in the
   *   reproducibility tuple is null (INV-P2).
   */
  writeProvenanceRecord(input: WriteProvenanceInput): Promise<ProvenanceRecord>;

  /**
   * Queries the ProvenanceRecord for a Dataset.
   * Returns null if no record exists.
   */
  queryProvenanceRecord(datasetId: DatasetId): Promise<ProvenanceRecord | null>;

  /**
   * Queries the ProvenanceRecord for a Job outcome.
   */
  queryProvenanceForJob(jobId: JobId): Promise<ProvenanceRecord | null>;

  /**
   * Queries the full lineage chain for a Dataset, tracing back
   * through input Datasets to the original source.
   */
  queryLineage(datasetId: DatasetId): Promise<ProvenanceRecord[]>;

  /**
   * Verifies a ProvenanceRecord exists and is valid for a Dataset
   * (INV-D3, INV-P3). Called by data-management before marking a
   * Dataset as consumable.
   *
   * @throws {ProvenanceError.RecordCorrupted} if the record exists
   *   but is corrupted (FM-P2). The caller should quarantine the
   *   Dataset (R11: local, not systemic).
   */
  verifyProvenance(datasetId: DatasetId): Promise<boolean>;

  /**
   * Attempts to reconstruct a corrupted/missing ProvenanceRecord
   * from available metadata (ToolInvocation logs, Environment
   * state). Returns null if reconstruction fails (FM-P2).
   */
  reconstructProvenanceRecord(input: ReconstructInput): Promise<ProvenanceRecord | null>;

  /**
   * Quarantines a Dataset whose ProvenanceRecord is corrupted or
   * missing. The Dataset is not available for downstream consumption.
   * Only the affected Dataset is quarantined — not the entire store
   * (R11).
   */
  quarantineDataset(datasetId: DatasetId, reason: string): Promise<void>;
}

interface WriteProvenanceInput {
  toolId: ToolId;         // name + version (INV-P2)
  parameters: Record<string, unknown>;  // exact parameters
  environmentId: EnvironmentId;         // Environment identity
  inputDatasetIds: DatasetId[];         // input Dataset identities
  outputDatasetId: DatasetId | null;    // null for failed invocations
  exitOutcome: ExitOutcome;
  timestamp: Date;        // ISO 8601
  jobId?: JobId;          // for Job-outcome records
  jobState?: JobState;    // for Job-outcome records
  caseId?: CaseId;        // for CESM records
}

interface ReconstructInput {
  datasetId: DatasetId;
  availableMetadata: {
    toolInvocationLogs?: string;
    environmentState?: Environment;
    partialRecord?: Partial<ProvenanceRecord>;
  };
}
```

**Events produced:** `ProvenanceEvent.record_written`,
`ProvenanceEvent.record_corrupted`, `ProvenanceEvent.record_reconstructed`,
`ProvenanceEvent.dataset_quarantined`.

**Events consumed:** None (C6 is a leaf module in the dependency
graph).

---

## 5. data-management (C3)

```typescript
/**
 * Dataset lifecycle management. Datasets are immutable (INV-D1),
 * have one Format and one Grid (INV-D2), and are not consumable
 * until their ProvenanceRecord exists (INV-D3).
 */
interface DataManagementService {
  /**
   * Registers a new Dataset with its Format, Grid, Variables, and
   * Location. The Dataset is created in a "pending" state — it is
   * NOT consumable until markConsumable() is called (which requires
   * a ProvenanceRecord, per INV-D3).
   *
   * @throws {DataError.LocationNotResolved} if the Location does
   *   not resolve to a valid path (INV-D4, FM-D3).
   */
  registerDataset(input: RegisterDatasetInput): Promise<Dataset>;

  /**
   * Queries a Dataset by identity.
   */
  queryDataset(id: DatasetId): Promise<Dataset | null>;

  /**
   * Lists Datasets, optionally filtered.
   */
  listDatasets(filter?: DatasetFilter): Promise<Dataset[]>;

  /**
   * Validates that a Location resolves to an existing, readable path
   * (for inputs) or a writable path (for outputs) at the time of use
   * (INV-D4). Called immediately before a ToolInvocation reads or
   * writes.
   *
   * @throws {DataError.LocationNotReadable} if read mode and path
   *   does not exist or is not readable (FM-D3).
   * @throws {DataError.LocationNotWritable} if write mode and path
   *   is not writable.
   * @throws {DataError.QuotaExceeded} if the filesystem reports
   *   quota exceeded (FM-D1).
   */
  validateLocation(location: Location, mode: 'read' | 'write'): Promise<boolean>;

  /**
   * Marks a Dataset as available for downstream consumption.
   * Precondition: provenance.verifyProvenance(datasetId) must return
   * true. This is the joint enforcement point for INV-D3 / INV-P3.
   *
   * @throws {DataError.ProvenanceMissing} if no ProvenanceRecord
   *   exists for the Dataset.
   */
  markConsumable(datasetId: DatasetId): Promise<void>;

  /**
   * Quarantines a Dataset. The Dataset is not available for
   * downstream consumption. Used for corrupted Datasets (FM-D5),
   * corrupted ProvenanceRecords (FM-P2, R11), and Datasets with
   * mismatched Provenance (FM-X5).
   */
  quarantineDataset(datasetId: DatasetId, reason: string): Promise<void>;
}

interface RegisterDatasetInput {
  name: string;
  location: Location;
  format: Format;
  grid: Grid;
  variables: Variable[];
  producerToolInvocationId?: ToolInvocationId; // null for manually registered
}

interface DatasetFilter {
  format?: Format;
  grid?: Grid;
  variableName?: string;
  producerToolInvocationId?: ToolInvocationId;
}
```

**Events produced:** `DatasetEvent.registered`, `DatasetEvent.
consumable`, `DatasetEvent.quarantined`, `DatasetEvent.
location_invalid`.

**Events consumed:** `ProvenanceEvent.record_written` (to know when a
ProvenanceRecord exists and the Dataset can be marked consumable).

---

## 6. tool-invocation (C1 — including CESM)

### Tool Catalog

```typescript
interface ToolCatalogService {
  /**
   * Returns all registered Tools. Used by agent-interaction to
   * validate LLM-generated Tool names (R12: refuse and ask if not
   * in catalog).
   */
  getToolCatalog(): Promise<Tool[]>;

  /**
   * Registers a Tool in the catalog.
   */
  registerTool(tool: Tool): Promise<void>;

  /**
   * Queries a single Tool by identity.
   */
  getTool(toolId: ToolId): Promise<Tool | null>;
}
```

### Tool Invocation

```typescript
interface ToolInvocationService {
  /**
   * Creates and executes a ToolInvocation. The full lifecycle:
   *
   * 1. Validate: Tool exists in catalog, parameters match Tool
   *    schema, input Datasets exist with Provenance (INV-W1, INV-D3).
   * 2. Verify Environment: load and verify the Tool's required
   *    Environment via environment-management (INV-T1, INV-E2).
   *    Re-verify immediately before execution.
   * 3. Validate Locations: input Locations resolve to readable paths,
   *    output Location resolves to writable path (INV-D4).
   * 4. Start: enter RUNNING state. If execution model is 'parallel',
   *    delegate to scheduling.submitJob() (X2). Otherwise, execute
   *    synchronously via dsh-adapter (ctx.shell or ctx.subprocess).
   * 5. Monitor: if parallel, poll scheduling.queryJob() until
   *    terminal state (INV-S1). If synchronous, wait for process.
   * 6. Complete/Fail: record ExitOutcome (INV-T2, INV-T5).
   *    If success (exit code 0, or in permissiveExitCodes — R4):
   *    write ProvenanceRecord (X4), register output Dataset via
   *    data-management, mark consumable.
   *    If failure: write ProvenanceRecord with null output, do NOT
   *    register output Dataset (INV-T3).
   *
   * @throws {ToolInvocationError.EnvironmentNotLoaded} if the
   *   required Environment is not loaded (INV-T1).
   * @throws {ToolInvocationError.InputNotFound} if an input Dataset
   *   does not exist (FM-T5).
   * @throws {ToolInvocationError.InvalidParameters} if parameters
   *   do not match the Tool schema.
   * @throws {ToolInvocationError.ToolNotFound} if the Tool is not
   *   in the catalog (FM-A1).
   */
  invokeTool(request: ToolInvocationRequest): Promise<ToolInvocationResult>;

  /**
   * Returns an AsyncObservable for monitoring a running
   * ToolInvocation (especially long-running parallel Jobs).
   */
  monitorInvocation(invocationId: ToolInvocationId): AsyncObservable<ToolInvocationEvent>;
}

interface ToolInvocationRequest {
  toolId: ToolId;
  parameters: Record<string, unknown>;
  inputDatasetIds: DatasetId[];
  outputLocation: Location;
  /**
   * Execution model: 'synchronous' for short CLI calls on login nodes,
   * 'parallel' for large operations submitted as SLURM Jobs.
   */
  executionModel: 'synchronous' | 'parallel';
  /**
   * Required for 'parallel' execution. Passed to scheduling.submitJob().
   */
  resourceRequest?: ResourceRequest;
  /**
   * R4 (strict exit codes): empty by default. Non-zero exit codes
   * are errors unless the User explicitly lists them here as
   * permissive for this specific ToolInvocation.
   */
  permissiveExitCodes?: number[];
}

interface ToolInvocationResult {
  invocation: ToolInvocation;
  outputDatasets: Dataset[];   // empty if failed
  provenanceRecord: ProvenanceRecord;
}
```

### CESM Case Lifecycle (Model Tool subtype)

CESM is a Model Tool (R1, ADR-001). The Case lifecycle is a
specialized ToolInvocation lifecycle:

```typescript
interface CaseService {
  /**
   * Creates a new CESM Case. The output tree Location is determined
   * at creation time (R5, INV-T9) and does not change.
   *
   * NOTE (FINDING-02, eventual consistency): The `experimentId` is
   * accepted WITHOUT synchronous validation. The dependency graph
   * (Phase 4) prohibits tool-invocation from importing
   * agent-interaction (Phase 5). Validation happens asynchronously
   * when agent-interaction.addCaseToExperiment() is called. If the
   * Experiment does not exist, ExperimentNotFound is thrown at that
   * point — the Case itself remains valid in C1.
   *
   * @throws {ToolInvocationError.InvalidParameters} if compset,
   *   resolution, or machine target is invalid.
   */
  createCase(input: CreateCaseInput): Promise<Case>;

  /**
   * Configures the Case (CESM's `case.setup` / XML configuration).
   * Case state: CREATED → CONFIGURED.
   *
   * This is a ToolInvocation (CESM is a Model Tool).
   *
   * @throws {ToolInvocationError.NonZeroExitCode} if configuration
   *   fails (FM-M5). Case remains in CREATED state.
   */
  configureCase(caseId: CaseId, config: CaseConfig): Promise<Case>;

  /**
   * Builds the Case (CESM's `case.build`).
   * Case state: CONFIGURED → BUILT on success, remains CONFIGURED on
   * failure (FM-M1).
   *
   * This is a ToolInvocation (CESM is a Model Tool).
   *
   * @throws {ToolInvocationError.NonZeroExitCode} if build fails.
   *   The build log is captured.
   * @throws {ToolInvocationError.EnvironmentNotLoaded} if the CESM
   *   Environment (compiler + MPI) is not loaded.
   */
  buildCase(caseId: CaseId): Promise<Case>;

  /**
   * Submits the Case via `case.submit`, which creates a SLURM Job
   * via scheduling.submitJob().
   *
   * Preconditions (validated before submission):
   * - Case must be in BUILT state (INV-T6, formerly INV-M1).
   * - Run length must not exceed Wall Time (INV-T8, formerly INV-M3).
   * - Output tree Location must be set and writable (INV-T9, formerly
   *   INV-M4, satisfied at creation per R5).
   * - No RUNNING Job already exists for this Case (INV-T7, formerly
   *   INV-M2).
   * - CESM Environment must be verified (re-verified before submit).
   *
   * Case state: BUILT → SUBMITTED. A ProvenanceRecord is created for
   * the Job.
   *
   * @throws {ToolInvocationError.CaseNotBuilt} if Case is not in
   *   BUILT state (INV-T6).
   * @throws {ToolInvocationError.RunLengthExceedsWallTime} if run
   *   length > wall time (INV-T8).
   * @throws {ToolInvocationError.OutputLocationNotSet} if output
   *   tree Location is not set (INV-T9).
   * @throws {ToolInvocationError.CaseAlreadyRunning} if a Job is
   *   already RUNNING for this Case (INV-T7).
   * @throws {SchedulingError.RejectedByScheduler} if SLURM rejects
   *   the submission (FM-S1).
   */
  submitCase(caseId: CaseId, resourceRequest: ResourceRequest): Promise<Case>;

  /**
   * Monitors the Case's Job via scheduling.queryJob() until a
   * terminal state is reached. Case state transitions: SUBMITTED →
   * RUNNING → COMPLETED/FAILED/TIMEOUT/CANCELLED.
   *
   * Returns an AsyncObservable for streaming state changes.
   */
  monitorCase(caseId: CaseId): AsyncObservable<CaseState>;

  /**
   * After the Job reaches COMPLETED, scans the output tree at the
   * recorded Location and registers Datasets via
   * data-management.registerDataset(). Each Dataset gets a
   * ProvenanceRecord referencing the Job.
   *
   * This is the "post-process" phase of the Case lifecycle.
   */
  registerCaseOutput(caseId: CaseId): Promise<Dataset[]>;
}

interface CreateCaseInput {
  name: string;
  compset: Compset;
  resolution: string;
  machine: string;
  runLength: Duration;          // e.g., "5 years"
  experimentId: ExperimentId;   // R2: Case belongs to exactly one Experiment
}

interface CaseConfig {
  runLength?: Duration;
  calendar?: string;            // e.g., "noleap"
  stopOption?: string;          // e.g., "nyears"
  customXml?: Record<string, string>;
}
```

**Events produced:** `ToolInvocationEvent.created`,
`ToolInvocationEvent.started`, `ToolInvocationEvent.completed`,
`ToolInvocationEvent.failed`, `ToolInvocationEvent.signal_terminated`,
`DatasetEvent.registered` (for output Datasets),
`ProvenanceEvent.record_written`.

**Events consumed:** `JobEvent.state_changed` (for parallel
ToolInvocations and CESM Cases), `EnvironmentEvent.loaded` (to know
when an Environment is ready).

---

## 7. agent-interaction (C7 — including Experiment, Workflow)

### Session

```typescript
interface SessionService {
  /**
   * Starts a new Session for a User.
   *
   * On start, proactively queries scheduling.queryJobsByUser() and
   * reports Job states to the User (R7, ADR-007). This is the
   * default behavior, not on-demand.
   *
   * @returns The new Session with an initial JobStatusReport.
   */
  startSession(user: User): Promise<Session>;

  /**
   * Ends the Session. Running Jobs are NOT cancelled (INV-W4).
   * The Session's Workflow state is persisted (R6, ADR-006).
   */
  endSession(sessionId: SessionId): Promise<void>;

  /**
   * Retrieves a Session by identity.
   */
  getSession(sessionId: SessionId): Promise<Session | null>;

  /**
   * Reports current Job states for the Session's User. Used both
   * proactively on Session start and on-demand.
   */
  reportJobStatus(sessionId: SessionId): Promise<JobStatusReport[]>;
}

interface JobStatusReport {
  jobId: JobId;
  state: JobState;
  caseId?: CaseId;
  workflowId?: WorkflowId;
  message?: string; // human-readable summary
}
```

### Experiment

```typescript
interface ExperimentService {
  /**
   * Creates a new Experiment (R2, ADR-002). An Experiment groups
   * Workflows and CESM Cases by a research question.
   */
  createExperiment(input: CreateExperimentInput): Promise<Experiment>;

  /**
   * Adds a Workflow to an Experiment. A Workflow belongs to exactly
   * one Experiment (R2).
   *
   * @throws {AgentError.WorkflowAlreadyAssigned} if the Workflow is
   *   already assigned to another Experiment.
   */
  addWorkflowToExperiment(experimentId: ExperimentId, workflowId: WorkflowId): Promise<void>;

  /**
   * Adds a Case to an Experiment. A Case belongs to exactly one
   * Experiment (R2).
   */
  addCaseToExperiment(experimentId: ExperimentId, caseId: CaseId): Promise<void>;

  /**
   * Queries Experiments for the User.
   */
  queryExperiments(filter?: ExperimentFilter): Promise<Experiment[]>;

  /**
   * Retrieves an Experiment by identity.
   */
  getExperiment(id: ExperimentId): Promise<Experiment | null>;
}

interface CreateExperimentInput {
  name: string;
  researchQuestion: string;
}

interface ExperimentFilter {
  name?: string;
}
```

### Workflow

```typescript
interface WorkflowService {
  /**
   * Creates a new Workflow belonging to an Experiment (R2).
   * The Workflow has persisted state (R6, ADR-006) and survives
   * Session end.
   *
   * @throws {AgentError.ExperimentNotFound} if the Experiment does
   *   not exist.
   */
  createWorkflow(input: CreateWorkflowInput): Promise<Workflow>;

  /**
   * Adds a WorkflowStep to a Workflow. A WorkflowStep is one Tool
   * invocation or Case submission, with explicit input Datasets and
   * output Datasets.
   */
  addWorkflowStep(workflowId: WorkflowId, step: WorkflowStepInput): Promise<void>;

  /**
   * Starts the Workflow. Each step's inputs are verified to exist
   * and have Provenance before starting (INV-W1).
   *
   * Steps execute in order. If a step fails, downstream steps do
   * NOT start automatically (INV-W2). The User is notified.
   *
   * If a step delegates to Scheduling (parallel execution), the
   * Workflow waits for the Job to reach a terminal state.
   *
   * @throws {AgentError.InputMissingProvenance} if any input Dataset
   *   lacks a ProvenanceRecord (INV-W1, INV-D3).
   */
  startWorkflow(workflowId: WorkflowId): Promise<void>;

  /**
   * Resumes a Workflow from its persisted state (R6). The Workflow
   * may have been interrupted by Session end while waiting for a
   * Job. On resume, the Agent queries the Scheduler for the Job's
   * current state and continues accordingly.
   */
  resumeWorkflow(workflowId: WorkflowId): Promise<void>;

  /**
   * Returns the current WorkflowState.
   */
  getWorkflowState(workflowId: WorkflowId): Promise<WorkflowState>;

  /**
   * Returns the full Workflow with all steps.
   */
  getWorkflow(workflowId: WorkflowId): Promise<Workflow | null>;
}

interface CreateWorkflowInput {
  name: string;
  experimentId: ExperimentId; // R2: belongs to exactly one Experiment
}

interface WorkflowStepInput {
  order: number;
  name: string;
  toolId: ToolId;
  parameters: Record<string, unknown>;
  inputDatasetIds: DatasetId[];
  outputDatasetId?: DatasetId;  // may not be known until step runs
  executionModel?: 'synchronous' | 'parallel';
  resourceRequest?: ResourceRequest;
}
```

### Action (LLM-facing concept, R3)

```typescript
interface ActionService {
  /**
   * Registers an Action (LLM-facing concept, R3). An Action is a
   * domain-level operation exposed to the LLM (e.g., "select
   * variable", "compute time mean", "remap grid"). An Action maps
   * to one or more CLI operators or Python calls.
   *
   * Actions are registered on dsh's ctx.tools so the LLM can
   * discover and invoke them.
   */
  registerAction(action: Action): Promise<void>;

  /**
   * Validates an Action request against the Tool catalog and input
   * Dataset metadata.
   *
   * R12 (ADR-010): If the Tool name or parameters are not in the
   * catalog, the Agent REFUSES and asks the User for clarification.
   * No best-effort attempts.
   *
   * @returns {ActionResult.Valid} if the request is valid.
   * @returns {ActionResult.Invalid} if validation fails, with a
   *   message for the User.
   * @returns {ActionResult.RefuseAndAsk} if the Tool or parameters
   *   are not in the catalog (R12).
   */
  validateAction(request: ActionRequest): ActionResult;

  /**
   * Lists all registered Actions (for the LLM).
   */
  listActions(): Promise<Action[]>;
}

type ActionResult =
  | { valid: true; toolInvocationRequest: ToolInvocationRequest }
  | { valid: false; reason: string; suggestion?: string }
  | { refuseAndAsk: true; message: string; availableTools: ToolId[] };

interface ActionRequest {
  actionName: string;
  parameters: Record<string, unknown>;
  inputDatasetIds: DatasetId[];
}
```

**Events produced:** `SessionEvent.started`, `SessionEvent.
proactive_job_report`, `SessionEvent.ended`, `WorkflowEvent.created`,
`WorkflowEvent.step_started`, `WorkflowEvent.step_completed`,
`WorkflowEvent.step_failed`, `WorkflowEvent.state_changed`,
`WorkflowEvent.resumed`, `ExperimentEvent.created`,
`ExperimentEvent.workflow_added`, `ExperimentEvent.case_added`.

**Events consumed:** `JobEvent.state_changed` (for proactive reporting
and Workflow step monitoring), `ToolInvocationEvent.completed` (to
advance Workflow steps), `ToolInvocationEvent.failed` (to halt
downstream Workflow steps).

---

## AsyncObservable Type

Several interfaces return `AsyncObservable<T>`, which is a
streaming type for long-running operations. It is a subset of
`AsyncIterable<T>` with additional lifecycle management:

```typescript
interface AsyncObservable<T> {
  /** Async iteration over events. */
  [Symbol.asyncIterator](): AsyncIterator<T>;

  /** Subscribe to events with a callback. Returns an unsubscribe fn. */
  subscribe(callback: (event: T) => void): () => void;

  /** Cancel the observable (e.g., stop polling a Job). */
  cancel(): void;
}
```

---

## Error Propagation Pattern

All service methods throw `CeraError` subclasses (see
`error-taxonomy.md` and `src/types/errors.ts`). The error carries:

1. **Error code** — discriminates the error type
2. **Severity** — from `failure-modes.md`
3. **User-facing message** — what the scientist sees
4. **Internal details** — for logging (not shown to the User)
5. **Recovery hint** — suggested next action

Callers catch errors at the appropriate level:

- **tool-invocation** catches `EnvironmentError` and `DataError` and
  wraps them in `ToolInvocationError` with context.
- **agent-interaction** catches `ToolInvocationError` and
  `SchedulingError` and translates them into user-facing messages.
- **No module catches errors from modules it doesn't depend on.**
